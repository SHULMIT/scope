// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    resolve: {
      conditions: ["source"],
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.integration.test.ts",
      "apps/*/src/**/*.integration.test.ts",
      "apps/workers/*/src/**/*.integration.test.ts",
      "apps/model-scanners/*/src/**/*.integration.test.ts",
    ],
    environment: "node",
    globals: false,
    testTimeout: 300_000, // 5 min — integration tests involve Docker builds
    hookTimeout: 600_000, // 10 min — beforeAll builds Docker images
    reporters: [
      "github-actions",
      "default",
      [
        "@d2t/vitest-ctrf-json-reporter",
        {
          outputFile: "scope-mt-integration-ctrf-report.json",
          outputDir: "./ctrf",
        },
      ],
    ],
  },
});
