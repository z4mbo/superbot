import type { BuildOptions } from "esbuild";

/** esbuild options that bundle the command into `outfile`. */
export function buildOptions(outfile: string): Promise<BuildOptions>;
