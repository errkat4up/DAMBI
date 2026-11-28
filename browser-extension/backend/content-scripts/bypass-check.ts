import Browser from "webextension-polyfill";
import { Identifier } from "@lib/identifier";
import { sendToPortAndDisregard } from "@lib/messages";
import { RequestType } from "@lib/types";
import { signatureFields, walletChainId, walletQuantity } from "@lib/wallet-request-fields";

// Zero records that the wallet has not reported a usable chain yet.
let metamaskChainId = 0;
const typedMethods = new Set(["eth_signTypedData", "eth_signTypedData_v3", "eth_signTypedData_v4"]);

function forwardBypassed(data: any): void {
  // `Browser.runtime.connect` throws "Extension context invalidated" when the
  // extension was reloaded but this page kept its stale runtime ID. Without
  // a catch the throw bubbles up and the MetaMask message handler dies
  // silently — every subsequent transaction passes through with no policy
  // evaluation, a fail-open bypass of the entire engine. Catch loudly so
  // the dApp console shows a clear "reload this tab" hint instead.
  try {
    const port = Browser.runtime.connect({ name: Identifier.CONTENT_SCRIPT });
    sendToPortAndDisregard(port, data);
  } catch (err) {
    console.error(
      "[Dambi] cannot reach service worker (extension reloaded?) — " +
        "policy evaluation skipped. Reload this tab.",
      err,
    );
  }
}

function checkMetaMaskBypass(messageData: any): void {
  const items = Array.isArray(messageData) ? messageData : [messageData];
  const hostname = location.hostname;
  for (const item of items) {
    if (!item) continue;
    const method = item.method;
    if (method === "eth_sendTransaction" || method === "eth_signTransaction") {
      const [transaction] = item.params ?? [];
      forwardBypassed({
        type: RequestType.TRANSACTION,
        method,
        bypassed: true,
        hostname,
        chainId: metamaskChainId,
        transaction,
      });
    } else if (typedMethods.has(method)) {
      const { address, message: typedDataStr } = signatureFields(method, item.params ?? []);
      try {
        const typedData =
          typeof typedDataStr === "string"
            ? JSON.parse(typedDataStr)
            : typedDataStr;
        forwardBypassed({
          type: RequestType.TYPED_SIGNATURE,
          method,
          bypassed: true,
          hostname,
          chainId: metamaskChainId,
          address,
          typedData,
        });
      } catch {
        /* ignore malformed typed data */
      }
    } else if (method === "eth_sign" || method === "personal_sign") {
      const { address, message } = signatureFields(method, item.params ?? []);
      forwardBypassed({
        type: RequestType.UNTYPED_SIGNATURE,
        method,
        address,
        chainId: metamaskChainId,
        bypassed: true,
        hostname,
        message: String(message ?? ""),
      });
    }
    // wallet_sendCalls (EIP-5792) is intentionally NOT observed in v1.
    // Plan 5/6 may revisit batch-evaluation semantics; until then, treating
    // each call as a bypassed transaction would surface confusing
    // half-evaluated state to the SW.
  }
}

window.addEventListener("message", (event) => {
  // N7: only trust messages posted from THIS frame's own window (the wallet's
  // in-page relay posts same-window). A cross-frame / forged source must not
  // inject observe-only bypass rows. (Same-origin same-page forgery is an
  // accepted residual — these rows are observe-only and never gate a verdict.)
  if (event.source !== window) return;
  const target = event?.data?.target;
  const inner = event?.data?.data;
  if (!inner) return;
  if (inner.name === Identifier.METAMASK_PROVIDER) {
    if (target === Identifier.METAMASK_CONTENT_SCRIPT)
      checkMetaMaskBypass(inner.data);
    if (
      target === Identifier.METAMASK_INPAGE &&
      (inner.data?.method === "metamask_chainChanged" || inner.data?.method === "chainChanged")
    ) {
      metamaskChainId = walletChainId(inner.data?.params?.chainId ?? inner.data?.params) ?? 0;
    }
  }
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return; // N7 — see the MetaMask listener above
  const { type, data } = event?.data ?? {};
  if (type !== Identifier.COINBASE_WALLET_REQUEST || !data) return;
  const hostname = location.hostname;
  if (data.request?.method === "signEthereumTransaction") {
    const params = data.request.params;
    if (!params) return;
    const wei = walletQuantity(params.weiValue ?? 0);
    forwardBypassed({
      type: RequestType.TRANSACTION,
      method: typeof params.shouldSubmit === "boolean"
        ? (params.shouldSubmit ? "eth_sendTransaction" : "eth_signTransaction")
        : undefined,
      bypassed: true,
      hostname,
      chainId: walletChainId(params.chainId) ?? 0,
      transaction: {
        from: data.request.params.fromAddress,
        to: data.request.params.toAddress,
        data: data.request.params.data,
        value: wei?.toString() ?? params.weiValue,
      },
    });
  } else if (data.request?.method === "signEthereumMessage") {
    const typedDataStr = data.request.params.typedDataJson;
    if (typedDataStr) {
      try {
        const typedData = JSON.parse(typedDataStr);
        forwardBypassed({
          type: RequestType.TYPED_SIGNATURE,
          bypassed: true,
          hostname,
          // This transport exposes no EIP-712 version or connected chain.
          chainId: walletChainId(data.request.params.chainId) ?? 0,
          address: data.request.params.address,
          typedData,
        });
      } catch {
        /* ignore */
      }
    } else {
      forwardBypassed({
        type: RequestType.UNTYPED_SIGNATURE,
        method: typeof data.request.params.addPrefix === "boolean"
          ? (data.request.params.addPrefix ? "personal_sign" : "eth_sign") : undefined,
        address: data.request.params.address,
        chainId: walletChainId(data.request.params.chainId) ?? 0,
        bypassed: true,
        hostname,
        message: String(data.request.params.message ?? ""),
      });
    }
  }
});
