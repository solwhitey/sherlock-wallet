export type IxLogGroup = {
  programId: string;
  logs: string[];
  computeUnits?: number;
  failed?: string;
  returnData?: { programId: string; data: string };
};

export type LogFailure = { programId: string; message: string; customCode?: number };

export type ParsedLogs = { groups: IxLogGroup[]; failure?: LogFailure; truncated: boolean };

const INVOKE = /^Program (\w+) invoke \[(\d+)\]$/;
const CONSUMED = /^Program (\w+) consumed (\d+) of (\d+) compute units$/;
const FAILED = /^Program (\w+) failed: (.*)$/;
const SUCCESS = /^Program (\w+) success$/;
const RETURN = /^Program return: (\w+) (\S*)$/;

// Splits simulation logs into one group per top-level instruction (an `invoke [1]` line opens a
// group), with the compute units and return data of that top-level call.
export function parseLogs(logs: string[] = []): ParsedLogs {
  const groups: IxLogGroup[] = [];
  let depth = 0;
  let failure: LogFailure | undefined;
  for (const line of logs) {
    const invoke = INVOKE.exec(line);
    if (invoke) {
      depth = Number(invoke[2]);
      if (depth === 1) groups.push({ programId: invoke[1], logs: [] });
    }
    const group = groups[groups.length - 1];
    group?.logs.push(line);
    if (invoke) continue;

    const consumed = CONSUMED.exec(line);
    if (consumed && depth === 1 && group && consumed[1] === group.programId) {
      group.computeUnits = Number(consumed[2]);
      continue;
    }
    const ret = RETURN.exec(line);
    if (ret && depth === 1 && group) {
      group.returnData = { programId: ret[1], data: ret[2] };
      continue;
    }
    const failed = FAILED.exec(line);
    if (failed) {
      // The first failure line is the innermost program that raised the error.
      if (!failure) {
        const custom = /custom program error: (0x[0-9a-fA-F]+)/.exec(failed[2]);
        failure = {
          programId: failed[1],
          message: failed[2],
          customCode: custom ? parseInt(custom[1], 16) : undefined,
        };
      }
      if (depth === 1 && group) group.failed = failed[2];
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (SUCCESS.test(line)) depth = Math.max(0, depth - 1);
  }
  return { groups, failure, truncated: logs.some((l) => l === 'Log truncated') };
}

// Returns, for each top-level instruction, the index of its log group (or -1). Instructions that
// never invoke (e.g. none today, but defensive) leave the mapping in order.
export function matchGroups(programIds: string[], groups: IxLogGroup[]): number[] {
  const out: number[] = [];
  let g = 0;
  for (const id of programIds) {
    while (g < groups.length && groups[g].programId !== id) g++;
    out.push(g < groups.length ? g++ : -1);
  }
  return out;
}
