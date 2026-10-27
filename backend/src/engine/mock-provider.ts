import type { AnalysisInput, AnalysisOutput, AnalysisProvider } from './provider.js';

/**
 * MOCK analysis provider — TEST DATA ONLY.
 *
 * Exists so the extension ↔ backend flow can be built and tested before the real engine is
 * specified. It reports only how many observations it received. It makes no prediction,
 * produces no signal and claims no accuracy.
 */
export class MockAnalysisProvider implements AnalysisProvider {
  readonly kind = 'mock' as const;
  readonly version = 'mock-1';
  readonly isTestData = true;

  async analyze(input: AnalysisInput): Promise<AnalysisOutput> {
    const n = input.observations.length;
    const notice =
      'TEST DATA — produced by a mock provider. This is not an analysis, a signal or a prediction.';
    if (n === 0) {
      return { status: 'insufficient_data', items: [{ label: 'Observations received (12 h)', value: '0' }], notice };
    }
    return {
      status: 'ok',
      items: [
        { label: 'Observations received (12 h)', value: String(n) },
        { label: 'Provider', value: 'Mock (test data)' },
      ],
      notice,
    };
  }
}
