import type { GeneratedMediaInfo } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { readJsonColumn } from "@rakazo/db";
import { z } from "zod";
import { generatedMediaInfo, MEDIA_JOB_KIND } from "./media-generation-tools.js";

const finishedJob = z.object({ artifactId: z.string().optional() });

/**
 * What made each of these artifacts, for the ones a media tool made: read from the finished job
 * that stored it, the same record its chat block was written from. Others are left out.
 */
export async function generatedMediaForArtifacts(
  prisma: Pick<PrismaClient, "externalEffect">,
  spaceId: string,
  artifactIds: readonly string[],
): Promise<Map<string, GeneratedMediaInfo>> {
  const found = new Map<string, GeneratedMediaInfo>();
  if (!artifactIds.length) return found;
  const jobs = await prisma.externalEffect.findMany({
    where: {
      spaceId,
      kind: MEDIA_JOB_KIND,
      status: "media_completed",
      OR: artifactIds.map((id) => ({ result: { path: ["artifactId"], equals: id } })),
    },
    select: { id: true, request: true, result: true },
  });
  for (const job of jobs) {
    const { artifactId } = readJsonColumn(
      finishedJob,
      job.result,
      { table: "external_effects", column: "result", id: job.id },
      { fallback: {} },
    );
    const generated = generatedMediaInfo(job.request);
    if (artifactId && generated) found.set(artifactId, generated);
  }
  return found;
}
