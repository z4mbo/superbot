import { exaSearchProvider } from "../../providers/web/exa/exa-search.js";
import { firecrawlScrapeProvider } from "../../providers/web/firecrawl/firecrawl-scrape.js";
import type { ResearchProvider, ResearchProviderDescriptor } from "./research-provider.js";

/** Optional web research providers a person turns on by saving their own key in Settings. */
const RESEARCH_PROVIDERS: readonly ResearchProvider[] = [
  exaSearchProvider,
  firecrawlScrapeProvider,
];

export function researchProviderDescriptors(): ResearchProviderDescriptor[] {
  return RESEARCH_PROVIDERS.map((provider) => provider.descriptor);
}

export function researchProvider(id: string): ResearchProvider | undefined {
  return RESEARCH_PROVIDERS.find((provider) => provider.descriptor.id === id);
}

export function researchProviderForTool(toolName: string): ResearchProvider | undefined {
  return RESEARCH_PROVIDERS.find((provider) => provider.descriptor.toolName === toolName);
}

/** Every tool a saved research key can turn on. */
export const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(
  RESEARCH_PROVIDERS.map((provider) => provider.descriptor.toolName),
);
