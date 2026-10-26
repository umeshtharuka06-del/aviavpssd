/**
 * Boundary between the API and the (future) proprietary analysis engine.
 *
 * The engine runs only on the VPS. It receives a read-only snapshot of recent, unexpired
 * observations and returns display items. It must not persist raw history anywhere, and it
 * plays no part in deleting history (the retention worker does that independently).
 *
 * The real engine is intentionally NOT implemented in this phase.
 */
export interface AnalysisInput {
  siteId: string;
  windowHours: number;
  /** Newest first. Only rows with received_at within the retention window. */
  observations: ReadonlyArray<{ multiplier: number; receivedAt: Date }>;
  now: Date;
}

export interface AnalysisOutput {
  status: 'ok' | 'insufficient_data';
  items: Array<{ label: string; value: string }>;
  /** Structured empirical metrics. Optional: the mock provider omits it. */
  metrics?: import('@aviator/contracts').AnalysisMetrics;
  /** Recent-pattern analysis (trends, streaks, distribution). Optional. */
  patterns?: import('@aviator/contracts').RecentPatterns;
  notice: string;
}

export interface AnalysisProvider {
  /** Public descriptor only. Never expose implementation details through these fields. */
  readonly kind: 'mock' | 'live';
  readonly version: string;
  /** true when outputs are placeholders; clients must label them as test data. */
  readonly isTestData: boolean;
  analyze(input: AnalysisInput): Promise<AnalysisOutput>;
}
