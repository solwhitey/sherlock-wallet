# Sherlock Wallet

<p align="center">
  <img width="200" height="200" src="https://github.com/TeamRaccoons/sherlock-wallet/assets/124664978/45189113-cd0e-4195-8c60-cef0a51aced6">
</p>

A development wallet to allow super easy inspection, debugging and bug reporting. Simulate the state you want and view the signTransaction call easily. 

Most dapps check your address and balances before allowing you to do actions. For example, Jupiter won't allow you to trigger a swap if you don't have the required input tokens, making debugging specific situations a pain in the ass sometimes.

With this system, you can pretend to be any given address, have some tokens or even some state in a program to trigger the same flow.


# Installation
### Chrome extension store
https://chromewebstore.google.com/detail/sherlock-wallet/fnkhhpcgjmehogcdgjihbfbbgcfmogmd

### Or, locally
To use the Sherlock Wallet, you need to have Node.js and pnpm installed. Then setup this repo with

`pnpm i`

`pnpm start`

In Chrome/Brave, Go to "More tools" > "Extensions." Enable "Developer mode" by toggling the switch on the top right corner of the page. Click on "Load unpacked" button, select the `dist` folder generated in this repo (or `build` after `pnpm build`).

# Features

- Legacy, v0 and v1 (SIMD-0385) transactions, decoded with @solana/kit; v1 header limits and flat priority fees are read and checked
- Use any Solana address on any wallet-standard dApp: `signTransaction`, `signAndSendTransaction`, `signAndSendAllTransactions` and `signMessage` all open the inspector (and are always rejected — Sherlock holds no keys)
- Simulation in the popup, re-run every 5 seconds against the current chain state (stale blockhashes are replaced):
  - balance changes for the impersonated address, in tokens and USD, and for every other owner touched (pools, vaults)
  - fees (base, priority, Jito tips), rent locked and reclaimed, compute used against the limit, loaded account data
  - checks: transaction size (1232 bytes for legacy/v0, 4096 for v1), compute headroom, priority fee against recent fees on the same accounts, expired blockhash, extra signers
  - errors decoded by name from the failing program's IDL (e.g. `SlippageToleranceExceeded`)
- Jupiter swaps (v6 `route`/`shared_accounts_route`/`exact_out` and the `_v2` variants used by Ultra):
  - quoted vs simulated amount in bps, minimum out / maximum in, and the room left before the slippage limit (what a sandwich could take)
  - value in vs out at Jupiter prices, platform fee and positive-slippage cap
  - route plan and the hops actually simulated, per AMM
  - when the swap reverts on slippage, it is simulated again with the limit opened to show how far past it the route fills
  - a fresh quote for the same trade to compare against, and a chart of the simulated output over time
- Instructions decoded from Anchor IDLs fetched on-chain (any program that publishes one), with inner instructions, events, per-instruction compute and account names
- Logs, accounts, raw base64, Explorer inspector link and a JSON report export
- Request history: reopen and re-simulate any past request; paste any serialized transaction (base64 or base58) to inspect it as one of your addresses
- RPC presets, including a local [Surfpool](https://surfpool.run) fork

The simulation engine (`src/sim`) has no browser dependencies. Run it from the command line with:

`RPC_URL=https://... pnpm inspect <tx.b64 | base64> [address]`

# Use cases

- Investigate user specific bugs, by reproducing their input using their address
- Reverse engineer dApps
- Test dApp with a wallet holding large token amounts

# Risks

- Too much fun

# Alternatives
https://github.com/everlastingsong/pubkey-sollet A slim inspection wallet through sollet wallet adapter
