// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! CAPI HMAC request-signing plugin.
//!
//! Lets the gateway authenticate to the Copilot API (CAPI) as a registered
//! integration using CAPI's service-to-service HMAC scheme instead of the
//! agent's per-user GitHub/Copilot token.
//!
//! For every request to a CAPI host in an opted-in session, the plugin:
//! - removes `Authorization` and any client-supplied `Request-HMAC`
//! - sets `Copilot-Integration-Id: <CAPI_INTEGRATION_ID>`
//! - sets `Request-HMAC: <unix_ts>.<hex(HMAC-SHA256(secret, unix_ts))>`
//! - removes `Copilot-Session-Token`, except on `/models/session[/intent]`
//!
//! Activation is opt-in at two levels, so default/community deployments that
//! use a regular GitHub token are unaffected:
//! 1. Gateway: `CAPI_HMAC_SECRET` and `CAPI_INTEGRATION_ID` must both be set
//!    in the gateway's environment. Credentials never travel in session
//!    settings and are therefore never persisted to the session store.
//! 2. Session: the session must be created with `{"capi_hmac": {"enabled": true}}`.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use hmac::{Hmac, Mac};
use http::header::{HeaderName, AUTHORIZATION};
use http::{HeaderMap, HeaderValue, Uri};
use parking_lot::RwLock;
use serde::Deserialize;
use sha2::Sha256;
use tracing::{debug, info, warn};

use crate::plugin::{HttpExchange, ProxyPlugin, SessionId};

type HmacSha256 = Hmac<Sha256>;

const ENV_SECRET: &str = "CAPI_HMAC_SECRET";
const ENV_INTEGRATION_ID: &str = "CAPI_INTEGRATION_ID";
const ENV_TARGET_HOSTS: &str = "CAPI_HMAC_TARGET_HOSTS";

const REQUEST_HMAC: HeaderName = HeaderName::from_static("request-hmac");
const COPILOT_INTEGRATION_ID: HeaderName = HeaderName::from_static("copilot-integration-id");
const COPILOT_SESSION_TOKEN: HeaderName = HeaderName::from_static("copilot-session-token");

/// Paths on which CAPI expects `Copilot-Session-Token` alongside the HMAC.
const SESSION_TOKEN_PATHS: &[&str] = &["/models/session", "/models/session/intent"];

/// Public Copilot API hosts (the same hosts every Copilot client talks to).
fn default_target_hosts() -> Vec<String> {
    vec![
        "api.githubcopilot.com".to_string(),
        "api.enterprise.githubcopilot.com".to_string(),
        "copilot-proxy.githubusercontent.com".to_string(),
    ]
}

/// Gateway-level CAPI integration credentials.
#[derive(Clone)]
pub struct CapiHmacCredentials {
    secret: String,
    integration_id: String,
    target_hosts: Vec<String>,
}

impl std::fmt::Debug for CapiHmacCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CapiHmacCredentials")
            .field("secret", &"[REDACTED]")
            .field("integration_id", &self.integration_id)
            .field("target_hosts", &self.target_hosts)
            .finish()
    }
}

impl CapiHmacCredentials {
    /// Build credentials, returning `None` when the secret or integration ID is
    /// blank. An empty `target_hosts` list falls back to the public CAPI hosts.
    pub fn new(secret: &str, integration_id: &str, target_hosts: Vec<String>) -> Option<Self> {
        let secret = secret.trim();
        let integration_id = integration_id.trim();
        if secret.is_empty() || integration_id.is_empty() {
            return None;
        }
        let target_hosts = if target_hosts.is_empty() {
            default_target_hosts()
        } else {
            target_hosts
        };
        Some(Self {
            secret: secret.to_string(),
            integration_id: integration_id.to_string(),
            target_hosts,
        })
    }

    /// Read credentials from the gateway environment
    /// (`CAPI_HMAC_SECRET`, `CAPI_INTEGRATION_ID`, optional `CAPI_HMAC_TARGET_HOSTS`).
    pub fn from_env() -> Option<Self> {
        let secret = std::env::var(ENV_SECRET).unwrap_or_default();
        let integration_id = std::env::var(ENV_INTEGRATION_ID).unwrap_or_default();
        let target_hosts = std::env::var(ENV_TARGET_HOSTS)
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .map(str::to_string)
            .collect();
        Self::new(&secret, &integration_id, target_hosts)
    }
}

/// Per-session settings provided under the `"capi_hmac"` key.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSettings {
    #[serde(default)]
    enabled: bool,
}

/// CAPI HMAC request-signing plugin.
pub struct CapiHmacPlugin {
    credentials: Option<CapiHmacCredentials>,
    sessions: Arc<RwLock<HashSet<SessionId>>>,
}

impl CapiHmacPlugin {
    pub fn new(credentials: Option<CapiHmacCredentials>) -> Self {
        Self {
            credentials,
            sessions: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    /// Construct from the gateway environment and log the activation state.
    pub fn from_env() -> Self {
        let credentials = CapiHmacCredentials::from_env();
        match &credentials {
            Some(c) => info!(
                "capi_hmac plugin: available (integration_id={}, targets={:?}); sessions must opt in",
                c.integration_id, c.target_hosts
            ),
            None => info!(
                "capi_hmac plugin: disabled ({} and {} not both set)",
                ENV_SECRET, ENV_INTEGRATION_ID
            ),
        }
        Self::new(credentials)
    }

    fn matches_target_host(uri: &Uri, target_hosts: &[String]) -> bool {
        uri.host()
            .is_some_and(|host| target_hosts.iter().any(|t| host.eq_ignore_ascii_case(t)))
    }

    /// Compute the `Request-HMAC` header value: `{ts}.{hex(HMAC-SHA256(secret, ts))}`.
    fn compute_request_hmac(secret: &str, timestamp: u64) -> anyhow::Result<String> {
        let ts = timestamp.to_string();
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
            .map_err(|e| anyhow::anyhow!("invalid HMAC key: {e}"))?;
        mac.update(ts.as_bytes());
        let digest = mac.finalize().into_bytes();

        let mut out = String::with_capacity(ts.len() + 1 + digest.len() * 2);
        out.push_str(&ts);
        out.push('.');
        for byte in digest {
            // Writing to a String is infallible.
            let _ = write!(out, "{byte:02x}");
        }
        Ok(out)
    }

    fn now_unix_secs() -> anyhow::Result<u64> {
        Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
    }

    /// Rewrite headers for a CAPI request. Separated from `on_request` for testing.
    fn apply(
        credentials: &CapiHmacCredentials,
        uri: &Uri,
        headers: &mut HeaderMap,
        timestamp: u64,
    ) -> anyhow::Result<()> {
        let request_hmac = Self::compute_request_hmac(&credentials.secret, timestamp)?;

        headers.remove(AUTHORIZATION);
        headers.remove(&REQUEST_HMAC);
        if !SESSION_TOKEN_PATHS.contains(&uri.path()) {
            headers.remove(&COPILOT_SESSION_TOKEN);
        }
        headers.insert(
            COPILOT_INTEGRATION_ID,
            HeaderValue::from_str(&credentials.integration_id)
                .map_err(|e| anyhow::anyhow!("invalid CAPI integration id: {e}"))?,
        );
        let mut hmac_value = HeaderValue::from_str(&request_hmac)
            .map_err(|e| anyhow::anyhow!("failed to encode Request-HMAC: {e}"))?;
        hmac_value.set_sensitive(true);
        headers.insert(REQUEST_HMAC, hmac_value);
        Ok(())
    }
}

#[async_trait]
impl ProxyPlugin for CapiHmacPlugin {
    fn name(&self) -> &str {
        "capi_hmac"
    }

    async fn on_session_start(&self, session_id: &SessionId, settings: &serde_json::Value) {
        let settings: SessionSettings = match serde_json::from_value(settings.clone()) {
            Ok(s) => s,
            Err(e) => {
                warn!("capi_hmac plugin: invalid settings for session {session_id}: {e}");
                return;
            }
        };
        if !settings.enabled {
            return;
        }
        if self.credentials.is_none() {
            warn!(
                "capi_hmac plugin: session {session_id} requested HMAC signing but the gateway \
                 has no CAPI credentials ({ENV_SECRET}/{ENV_INTEGRATION_ID}); requests pass through unchanged"
            );
            return;
        }
        info!("capi_hmac plugin: activated for session {session_id}");
        self.sessions.write().insert(session_id.clone());
    }

    async fn on_request(
        &self,
        session_id: &SessionId,
        uri: &Uri,
        headers: &mut HeaderMap,
    ) -> anyhow::Result<()> {
        let Some(credentials) = &self.credentials else {
            return Ok(());
        };
        if !self.sessions.read().contains(session_id)
            || !Self::matches_target_host(uri, &credentials.target_hosts)
        {
            return Ok(());
        }

        Self::apply(credentials, uri, headers, Self::now_unix_secs()?)?;
        debug!("capi_hmac plugin: signed request to {uri} for session {session_id}");
        Ok(())
    }

    async fn on_exchange(
        &self,
        _session_id: &SessionId,
        _exchange: &HttpExchange,
        _iteration: u32,
    ) {
    }

    async fn on_session_stop(&self, session_id: &SessionId) {
        debug!("capi_hmac plugin: session stopped for {session_id}");
    }

    async fn on_session_clear(&self, session_id: &SessionId) {
        self.sessions.write().remove(session_id);
        debug!("capi_hmac plugin: session cleared for {session_id}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SECRET: &str = "test-secret";
    const TS: u64 = 1_720_000_000;
    // python3 -c "import hmac,hashlib;print(hmac.new(b'test-secret',b'1720000000',hashlib.sha256).hexdigest())"
    const EXPECTED_HEX: &str = "2fb6b16b6feb3d88fa2398f7e30c97041f0f482097f872ae9e0381c3796557bd";

    fn creds() -> CapiHmacCredentials {
        CapiHmacCredentials::new(SECRET, "test-integration", vec![]).unwrap()
    }

    fn uri(s: &str) -> Uri {
        s.parse().unwrap()
    }

    fn sid(s: &str) -> SessionId {
        s.to_string()
    }

    async fn enabled_plugin() -> CapiHmacPlugin {
        let plugin = CapiHmacPlugin::new(Some(creds()));
        plugin
            .on_session_start(&sid("s1"), &json!({"enabled": true}))
            .await;
        plugin
    }

    fn client_headers() -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, "Bearer user-token".parse().unwrap());
        h.insert("request-hmac", "client-supplied".parse().unwrap());
        h.insert("copilot-integration-id", "vscode-chat".parse().unwrap());
        h.insert("copilot-session-token", "sess".parse().unwrap());
        h.insert("content-type", "application/json".parse().unwrap());
        h
    }

    #[test]
    fn request_hmac_matches_reference_vector() {
        let value = CapiHmacPlugin::compute_request_hmac(SECRET, TS).unwrap();
        assert_eq!(value, format!("{TS}.{EXPECTED_HEX}"));
    }

    #[test]
    fn credentials_require_secret_and_integration_id() {
        assert!(CapiHmacCredentials::new("", "id", vec![]).is_none());
        assert!(CapiHmacCredentials::new("secret", "  ", vec![]).is_none());
        let c = CapiHmacCredentials::new(" secret \n", " id ", vec![]).unwrap();
        assert_eq!(c.secret, "secret");
        assert_eq!(c.integration_id, "id");
        assert_eq!(c.target_hosts, default_target_hosts());
    }

    #[test]
    fn credentials_debug_redacts_secret() {
        let dbg = format!("{:?}", creds());
        assert!(!dbg.contains(SECRET));
        assert!(dbg.contains("[REDACTED]"));
    }

    #[test]
    fn custom_target_hosts_override_defaults() {
        let c = CapiHmacCredentials::new("s", "id", vec!["capi.example.test".into()]).unwrap();
        assert_eq!(c.target_hosts, vec!["capi.example.test".to_string()]);
    }

    #[test]
    fn apply_rewrites_auth_headers() {
        let mut h = client_headers();
        CapiHmacPlugin::apply(
            &creds(),
            &uri("https://api.githubcopilot.com/chat/completions"),
            &mut h,
            TS,
        )
        .unwrap();

        assert!(h.get(AUTHORIZATION).is_none());
        assert!(h.get("copilot-session-token").is_none());
        assert_eq!(h["copilot-integration-id"], "test-integration");
        assert_eq!(h["request-hmac"], format!("{TS}.{EXPECTED_HEX}").as_str());
        assert!(h["request-hmac"].is_sensitive());
        assert_eq!(h.get_all("request-hmac").iter().count(), 1);
        assert_eq!(h["content-type"], "application/json");
    }

    #[test]
    fn apply_keeps_session_token_on_session_paths() {
        for path in SESSION_TOKEN_PATHS {
            let mut h = client_headers();
            let u = uri(&format!("https://api.githubcopilot.com{path}?x=1"));
            CapiHmacPlugin::apply(&creds(), &u, &mut h, TS).unwrap();
            assert_eq!(h["copilot-session-token"], "sess", "path {path}");
            assert!(h.get(AUTHORIZATION).is_none());
        }
    }

    #[tokio::test]
    async fn signs_opted_in_session_on_target_host() {
        let plugin = enabled_plugin().await;
        let mut h = client_headers();
        plugin
            .on_request(
                &sid("s1"),
                &uri("https://api.githubcopilot.com/models"),
                &mut h,
            )
            .await
            .unwrap();
        assert!(h.get(AUTHORIZATION).is_none());
        let value = h["request-hmac"].to_str().unwrap();
        let (ts, hex) = value.split_once('.').unwrap();
        assert!(ts.parse::<u64>().is_ok());
        assert_eq!(hex.len(), 64);
        assert!(hex
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[tokio::test]
    async fn host_match_is_case_insensitive() {
        let plugin = enabled_plugin().await;
        let mut h = client_headers();
        plugin
            .on_request(
                &sid("s1"),
                &uri("https://API.GitHubCopilot.com/models"),
                &mut h,
            )
            .await
            .unwrap();
        assert!(h.get(AUTHORIZATION).is_none());
    }

    #[tokio::test]
    async fn non_target_host_untouched() {
        let plugin = enabled_plugin().await;
        let mut h = client_headers();
        let before = h.clone();
        plugin
            .on_request(&sid("s1"), &uri("https://api.github.com/user"), &mut h)
            .await
            .unwrap();
        assert_eq!(h, before);
    }

    #[tokio::test]
    async fn session_without_opt_in_untouched() {
        let plugin = CapiHmacPlugin::new(Some(creds()));
        for settings in [
            json!({}),
            json!({"enabled": false}),
            serde_json::Value::Null,
        ] {
            plugin.on_session_start(&sid("s1"), &settings).await;
        }
        let mut h = client_headers();
        let before = h.clone();
        plugin
            .on_request(
                &sid("s1"),
                &uri("https://api.githubcopilot.com/models"),
                &mut h,
            )
            .await
            .unwrap();
        assert_eq!(h, before);
    }

    #[tokio::test]
    async fn opt_in_without_gateway_credentials_is_noop() {
        let plugin = CapiHmacPlugin::new(None);
        plugin
            .on_session_start(&sid("s1"), &json!({"enabled": true}))
            .await;
        assert!(plugin.sessions.read().is_empty());
        let mut h = client_headers();
        let before = h.clone();
        plugin
            .on_request(
                &sid("s1"),
                &uri("https://api.githubcopilot.com/models"),
                &mut h,
            )
            .await
            .unwrap();
        assert_eq!(h, before);
    }

    #[tokio::test]
    async fn invalid_settings_do_not_activate() {
        let plugin = CapiHmacPlugin::new(Some(creds()));
        plugin
            .on_session_start(&sid("s1"), &json!({"enabled": "yes"}))
            .await;
        assert!(plugin.sessions.read().is_empty());
    }

    #[tokio::test]
    async fn other_sessions_unaffected() {
        let plugin = enabled_plugin().await;
        let mut h = client_headers();
        let before = h.clone();
        plugin
            .on_request(
                &sid("s2"),
                &uri("https://api.githubcopilot.com/models"),
                &mut h,
            )
            .await
            .unwrap();
        assert_eq!(h, before);
    }

    #[tokio::test]
    async fn session_clear_deactivates() {
        let plugin = enabled_plugin().await;
        plugin.on_session_clear(&sid("s1")).await;
        assert!(plugin.sessions.read().is_empty());
    }
}
