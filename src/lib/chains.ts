export type ChainId =
  | "solana"
  | "base"
  | "bnb"
  | "ethereum"
  | "arbitrum"
  | "optimism"
  | "polygon";

export type ChainKind = "svm" | "evm";

export interface Chain {
  id: ChainId;
  label: string;
  kind: ChainKind;
  /** Value the `blockchain` column uses in dex.trades / balances_<chain>.latest */
  duneName: string;
  nativeSymbol: string;
  explorer: (address: string) => string;
  accent: string;
}

export const CHAINS: Record<ChainId, Chain> = {
  solana: {
    id: "solana",
    label: "Solana",
    kind: "svm",
    duneName: "solana",
    nativeSymbol: "SOL",
    explorer: (a) => `https://solscan.io/account/${a}`,
    accent: "#14f195",
  },
  bnb: {
    id: "bnb",
    label: "BNB Chain",
    kind: "evm",
    duneName: "bnb",
    nativeSymbol: "BNB",
    explorer: (a) => `https://bscscan.com/address/${a}`,
    accent: "#f0b90b",
  },
  base: {
    id: "base",
    label: "Base",
    kind: "evm",
    duneName: "base",
    nativeSymbol: "ETH",
    explorer: (a) => `https://basescan.org/address/${a}`,
    accent: "#3c7dff",
  },
  ethereum: {
    id: "ethereum",
    label: "Ethereum",
    kind: "evm",
    duneName: "ethereum",
    nativeSymbol: "ETH",
    explorer: (a) => `https://etherscan.io/address/${a}`,
    accent: "#8a92b2",
  },
  arbitrum: {
    id: "arbitrum",
    label: "Arbitrum",
    kind: "evm",
    duneName: "arbitrum",
    nativeSymbol: "ETH",
    explorer: (a) => `https://arbiscan.io/address/${a}`,
    accent: "#2d9fda",
  },
  optimism: {
    id: "optimism",
    label: "Optimism",
    kind: "evm",
    duneName: "optimism",
    nativeSymbol: "ETH",
    explorer: (a) => `https://optimistic.etherscan.io/address/${a}`,
    accent: "#ff0420",
  },
  polygon: {
    id: "polygon",
    label: "Polygon",
    kind: "evm",
    duneName: "polygon",
    nativeSymbol: "POL",
    explorer: (a) => `https://polygonscan.com/address/${a}`,
    accent: "#8247e5",
  },
};

/** The chains shown up front, in the order they appear in the rail. */
export const FEATURED_CHAINS: ChainId[] = ["solana", "bnb", "base"];

export const ALL_CHAIN_IDS = Object.keys(CHAINS) as ChainId[];

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
// base58: no 0, O, I or l
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value.trim());
}

export function isSolanaAddress(value: string): boolean {
  return SOLANA_ADDRESS.test(value.trim());
}

export function isChainId(value: unknown): value is ChainId {
  return typeof value === "string" && value in CHAINS;
}

/**
 * Work out which chain a pasted contract address belongs to.
 * An EVM address is ambiguous across chains, so it only narrows to "some EVM
 * chain" — the caller supplies the chain, and we default to Base because that
 * is where most of the memecoin flow this tool is pointed at lives.
 */
export function detectChain(address: string): ChainId | null {
  const value = address.trim();
  if (isSolanaAddress(value)) return "solana";
  if (isEvmAddress(value)) return "base";
  return null;
}

export function isAddressValidForChain(address: string, chain: ChainId): boolean {
  const value = address.trim();
  return CHAINS[chain].kind === "svm" ? isSolanaAddress(value) : isEvmAddress(value);
}

export function normalizeAddress(address: string, chain: ChainId): string {
  const value = address.trim();
  return CHAINS[chain].kind === "evm" ? value.toLowerCase() : value;
}
