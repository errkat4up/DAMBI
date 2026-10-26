import { createScamFactProvider } from "@dambi/core/adapters";
import { installScamSwProbe } from "../../scripts/sdk/scam-sw-diagnostic.mjs";

installScamSwProbe(globalThis, createScamFactProvider);
console.info("AH5-2 diagnostic installed. Call dambiScamProbe.start(), then prepare()/fetch(). No RPC has run yet.");
