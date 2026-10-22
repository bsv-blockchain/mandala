import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { configureMandala } from '@bsv/mandala'
import App from './App'
import DevModeToggle from './components/DevModeToggle'
import { WalletProvider } from './context/WalletContext'
import { queryClient } from './lib/queryClient'
import { readMandalaConfig } from './lib/mandala/config'
import './globals.css'

// The library reads no environment (it must stay Metro/Hermes-safe), so the
// app hands Vite's env over before anything renders. VITE_ADMIN_API_TOKEN is
// optional and only travels on the identity-bearing /admin routes.
//
// S5 fail closed: a missing or malformed overlay identity key (or overlay /
// MessageBox URL) configures nothing and hands the reason to WalletProvider,
// which then never constructs a wallet, so no wallet flow can start against an
// unknown overlay.
//
// No basket is configured: holder value lives in the wallet's BRC-207 per-asset
// `p color` baskets and issuer outputs in the lib's fixed TREASURY_BASKET.
//
// No `storage` adapter is passed: on the web the library's default is
// localStorage, which is what the journals want here. A React Native host has
// no localStorage and MUST pass one (configureMandala({ storage }) or
// configureStorage) or its journals die with the process — see lib/src/storage.ts.
const env = import.meta.env
const mandalaConfig = readMandalaConfig({
  VITE_OVERLAY_URL: env.VITE_OVERLAY_URL,
  VITE_OVERLAY_IDENTITY_KEY: env.VITE_OVERLAY_IDENTITY_KEY,
  VITE_MESSAGEBOX_URL: env.VITE_MESSAGEBOX_URL,
  VITE_ADMIN_API_TOKEN: env.VITE_ADMIN_API_TOKEN
})
if (mandalaConfig.ok) {
  configureMandala(mandalaConfig.config)
} else {
  console.error('[mandala] refusing to start:', mandalaConfig.reason)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <WalletProvider configError={mandalaConfig.ok ? null : mandalaConfig.reason}>
          <App />
          <DevModeToggle />
          <Toaster richColors theme="system" position="top-right" />
        </WalletProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>
)
