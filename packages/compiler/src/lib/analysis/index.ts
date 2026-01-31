/**
 * Static analysis passes for the Zena compiler.
 *
 * @module
 */

export {
  analyzeUsage,
  isPureModule,
  getStatementDeclaration,
  type UsageInfo,
  type UsageAnalysisResult,
  type UsageAnalysisOptions,
} from './usage.js';
