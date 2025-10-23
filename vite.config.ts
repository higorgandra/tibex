import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/tibex/', // Use o nome do seu repositório aqui!
  plugins: [react()],
})


