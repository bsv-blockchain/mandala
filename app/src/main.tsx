import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { configureMandala } from '@bsv/mandala/constants'
import App from './App'
import DevModeToggle from './components/DevModeToggle'
import { WalletProvider } from './context/WalletContext'
import { queryClient } from './lib/queryClient'
import './globals.css'

// The library reads no environment (it must stay Metro/Hermes-safe), so the
// app hands Vite's env over before anything renders. VITE_ADMIN_API_TOKEN is
// optional and only travels on the identity-bearing /admin routes.
//
// No `storage` adapter is passed: on the web the library's default is
// localStorage, which is what the journals want here. A React Native host has
// no localStorage and MUST pass one (configureMandala({ storage }) or
// configureStorage) or its journals die with the process — see lib/src/storage.ts.
configureMandala({
  overlayUrl: import.meta.env.VITE_OVERLAY_URL ?? '',
  overlayIdentityKey: import.meta.env.VITE_OVERLAY_IDENTITY_KEY ?? '',
  messageBoxUrl: import.meta.env.VITE_MESSAGEBOX_URL ?? '',
  adminApiToken: import.meta.env.VITE_ADMIN_API_TOKEN ?? ''
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <WalletProvider>
          <App />
          <DevModeToggle />
          <Toaster richColors theme="system" position="top-right" />
        </WalletProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>
)
