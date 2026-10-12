import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Port 5174 so it can run next to the CRM frontend (5173).
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
})
