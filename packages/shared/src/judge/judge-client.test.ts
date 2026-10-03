// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  JudgeClient,
  JudgeInfrastructureError,
  isRetryableJudgeError,
} from "./judge-client.js";

function mockFetchResponse(opts: {
  ok: boolean;
  status: number;
  body?: string;
  json?: unknown;
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: opts.ok,
      status: opts.status,
      text: async () => opts.body ?? "",
      json: async () => opts.json ?? {},
    })
  );
}

const request = {
  snapshotUrl: "https://example/snap.tar.gz",
  criteria: ["c1"],
  conversationHistory: [],
};

describe("JudgeClient error classification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws JudgeInfrastructureError with isVersionMismatch on protocol mismatch", async () => {
    mockFetchResponse({
      ok: false,
      status: 500,
      body: '{"error":"Judge evaluation failed: SDK protocol version mismatch: SDK expects version 2, but server reports version 3."}',
    });
    const client = new JudgeClient("http://judge", { maxRetries: 0 });

    const error = await client.evaluate(request).catch((e) => e);
    expect(error).toBeInstanceOf(JudgeInfrastructureError);
    expect((error as JudgeInfrastructureError).isVersionMismatch).toBe(true);
    expect((error as JudgeInfrastructureError).httpStatus).toBe(500);
  });

  it("throws JudgeInfrastructureError (not version mismatch) on generic 5xx", async () => {
    mockFetchResponse({ ok: false, status: 503, body: "upstream unavailable" });
    const client = new JudgeClient("http://judge", { maxRetries: 0 });

    const error = await client.evaluate(request).catch((e) => e);
    expect(error).toBeInstanceOf(JudgeInfrastructureError);
    expect((error as JudgeInfrastructureError).isVersionMismatch).toBe(false);
  });

  it("throws a plain Error (not infrastructure) on a 4xx", async () => {
    mockFetchResponse({ ok: false, status: 400, body: "bad request" });
    const client = new JudgeClient("http://judge", { maxRetries: 0 });

    const error = await client.evaluate(request).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(JudgeInfrastructureError);
  });

  it("returns the parsed result on success", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: { passed: true, feedback: "All requirements met." },
    });
    const client = new JudgeClient("http://judge", { maxRetries: 0 });

    const result = await client.evaluate(request);
    expect(result.passed).toBe(true);
    expect(result.feedback).toBe("All requirements met.");
  });
});

describe("isRetryableJudgeError", () => {
  it("retries transient judge-side 5xx infrastructure errors", () => {
    const err = new JudgeInfrastructureError("judge boom", {
      httpStatus: 503,
      isVersionMismatch: false,
    });
    expect(isRetryableJudgeError(err)).toBe(true);
  });

  it("does NOT retry a protocol version mismatch (won't self-heal)", () => {
    const err = new JudgeInfrastructureError("protocol mismatch", {
      httpStatus: 500,
      isVersionMismatch: true,
    });
    expect(isRetryableJudgeError(err)).toBe(false);
  });

  it("does NOT retry 4xx infrastructure errors", () => {
    const err = new JudgeInfrastructureError("bad request", {
      httpStatus: 400,
      isVersionMismatch: false,
    });
    expect(isRetryableJudgeError(err)).toBe(false);
  });

  it("retries transient network failures", () => {
    expect(isRetryableJudgeError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableJudgeError(new Error("The operation was aborted"))).toBe(true);
  });

  it("retries a bare undici 'fetch failed' whose reason is only in error.cause", () => {
    // undici throws TypeError: fetch failed with the real reason in `.cause`.
    const err = new TypeError("fetch failed", {
      cause: new Error("read ECONNRESET"),
    });
    expect(isRetryableJudgeError(err)).toBe(true);
  });

  it("retries when the cause carries only a code (no matching substring in message)", () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(new Error("socket error"), { code: "ECONNRESET" }),
    });
    expect(isRetryableJudgeError(err)).toBe(true);
  });

  it("retries a 'fetch failed' even when the cause has no recognizable token", () => {
    // The literal "fetch failed" match alone makes transport failures retryable.
    const err = new TypeError("fetch failed", { cause: new Error("boom") });
    expect(isRetryableJudgeError(err)).toBe(true);
  });

  it("does not retry unrelated errors", () => {
    expect(isRetryableJudgeError(new Error("criteria not met"))).toBe(false);
    expect(isRetryableJudgeError(new Error("criteria mismatch"))).toBe(false);
    expect(isRetryableJudgeError(null)).toBe(false);
  });
});

describe("JudgeClient retries transport-level fetch failures", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries a 'fetch failed' rejection and then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError("fetch failed", { cause: new Error("read ECONNRESET") })
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ passed: true, feedback: "recovered after retry" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new JudgeClient("http://judge", { maxRetries: 2 });
    const promise = client.evaluate(request);
    // Advance past the backoff window (base 5s, max 30s incl. jitter) so the
    // retry fires without waiting in real time.
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.passed).toBe(true);
    expect(result.feedback).toBe("recovered after retry");
  });
});
