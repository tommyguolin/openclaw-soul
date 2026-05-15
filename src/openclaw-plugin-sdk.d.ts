declare module "openclaw:plugin-sdk/memory-host-core" {
  export interface MemorySearchHit {
    title?: string;
    snippet?: string;
    source?: string;
  }

  export interface MemoryCorpusSupplement {
    search(params: { query: string; maxResults?: number }): Promise<MemorySearchHit[]>;
  }

  export interface MemoryCorpusRegistration {
    pluginId: string;
    supplement: MemoryCorpusSupplement;
  }

  export function listMemoryCorpusSupplements(): MemoryCorpusRegistration[];
}
