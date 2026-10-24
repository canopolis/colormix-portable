// Types for the Emscripten module generated in GitHub Actions from the cpp/ folder of this repo
declare const createColorinWasm: () => Promise<{
  cwrap: (name: string, ret: string, args: string[]) => (...a: unknown[]) => unknown;
}>;
export default createColorinWasm;
