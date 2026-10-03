// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export interface TelemetryMetric {
  name: string;
  value: number;
  properties?: Record<string, string>;
}

export interface TelemetryTrace {
  message: string;
  severityLevel?: "Verbose" | "Information" | "Warning" | "Error" | "Critical";
  properties?: Record<string, string>;
}

export interface TelemetryEvent {
  name: string;
  properties?: Record<string, string>;
  measurements?: Record<string, number>;
}

export interface TelemetryDependency {
  name: string;
  dependencyTypeName: string;
  duration: number;
  success: boolean;
  data?: string;
  properties?: Record<string, string>;
}
