// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Remark plugin: transforms ```http``` fenced code blocks into a
// Starlight <Tabs> group with one tab per target language, generated
// at build time via httpsnippet-lite.
//
// Authoring convention: write a single raw HTTP request (with optional
// headers and body) inside an `http` code fence. Example:
//
//   ```http
//   POST /api/v1/task-prompts
//   Content-Type: application/json
//
//   { "text": "..." }
//   ```
//
// The plugin emits curl, JS fetch, and Python requests variants in a
// synced tab group (syncKey="http-lang"), so picking a language once
// is remembered across all snippets and pages.

import { visit } from 'unist-util-visit';
import { HTTPSnippet } from 'httpsnippet-lite';
import { parse as acornParse } from 'acorn';

const DEFAULT_BASE = 'https://your-scope.example.com';

// [label, target, client, fenced-code lang]
const TARGETS = [
	['curl', 'shell', 'curl', 'sh'],
	['JS (fetch)', 'javascript', 'fetch', 'js'],
	['Python', 'python', 'requests', 'py'],
	['Go', 'go', 'native', 'go'],
	['Java', 'java', 'okhttp', 'java'],
	['C#', 'csharp', 'httpclient', 'cs'],
];

const IMPORT_STMT =
	"import { Tabs, TabItem } from '@astrojs/starlight/components';";

function parseHttpRequest(raw, baseUrl) {
	const lines = raw.split(/\r?\n/);
	let i = 0;
	while (i < lines.length && lines[i].trim() === '') i++;
	if (i >= lines.length) return null;

	const requestLine = lines[i].trim();
	const m = /^([A-Z]+)\s+(\S+)(?:\s+HTTP\/[\d.]+)?$/.exec(requestLine);
	if (!m) return null;
	const [, method, target] = m;
	i++;

	const headers = {};
	for (; i < lines.length && lines[i].trim() !== ''; i++) {
		const h = /^([^:]+):\s*(.*)$/.exec(lines[i]);
		if (h) headers[h[1].trim()] = h[2].trim();
	}
	// skip the single blank separator
	if (i < lines.length && lines[i].trim() === '') i++;
	const body = lines.slice(i).join('\n').trim();

	let url;
	try {
		url = new URL(target);
	} catch {
		url = new URL(target, baseUrl);
	}

	const har = {
		method,
		url: `${url.origin}${url.pathname}`,
		httpVersion: 'HTTP/1.1',
		headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
		queryString: [...url.searchParams.entries()].map(([name, value]) => ({
			name,
			value,
		})),
		cookies: [],
		headersSize: -1,
		bodySize: body.length,
	};

	if (body) {
		har.postData = {
			mimeType: headers['Content-Type'] || 'application/json',
			text: body,
		};
	}

	return har;
}

function makeImportNode() {
	return {
		type: 'mdxjsEsm',
		value: IMPORT_STMT,
		data: {
			estree: acornParse(IMPORT_STMT, {
				ecmaVersion: 'latest',
				sourceType: 'module',
			}),
		},
	};
}

function hasStarlightImport(tree) {
	return tree.children.some(
		(n) =>
			n.type === 'mdxjsEsm' &&
			typeof n.value === 'string' &&
			n.value.includes("'@astrojs/starlight/components'"),
	);
}

function makeTabsNode(variants) {
	return {
		type: 'mdxJsxFlowElement',
		name: 'Tabs',
		attributes: [
			{ type: 'mdxJsxAttribute', name: 'syncKey', value: 'http-lang' },
		],
		children: variants.map((v) => ({
			type: 'mdxJsxFlowElement',
			name: 'TabItem',
			attributes: [
				{ type: 'mdxJsxAttribute', name: 'label', value: v.label },
			],
			children: [
				{
					type: 'code',
					lang: v.lang,
					meta: null,
					value: v.code,
				},
			],
		})),
	};
}

export default function remarkHttpSnippets(options = {}) {
	const baseUrl = options.baseUrl || DEFAULT_BASE;

	return async function transformer(tree) {
		const jobs = [];

		visit(tree, 'code', (node, index, parent) => {
			if (!parent || index == null) return;
			if (node.lang !== 'http') return;
			const har = parseHttpRequest(node.value, baseUrl);
			if (!har) return;

			jobs.push(async () => {
				const snippet = new HTTPSnippet(har);
				const variants = await Promise.all(
					TARGETS.map(async ([label, target, client, lang]) => {
						let code = '';
						try {
							const out = await snippet.convert(target, client);
							code = typeof out === 'string' ? out : '';
						} catch {
							code = '';
						}
						return { label, lang, code: code.trim() };
					}),
				);
				return { parent, index, node: makeTabsNode(variants) };
			});
		});

		if (jobs.length === 0) return;

		const results = await Promise.all(jobs.map((j) => j()));
		// Replace from highest index to lowest so earlier indices stay valid.
		results
			.sort((a, b) => b.index - a.index)
			.forEach(({ parent, index, node }) => {
				parent.children.splice(index, 1, node);
			});

		if (!hasStarlightImport(tree)) {
			tree.children.unshift(makeImportNode());
		}
	};
}
