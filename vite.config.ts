import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Web (GitHub Pages): base '/color-mix-lab/'
// Escritorio (.exe, "vite build --mode electron"): rutas relativas './'
export default defineConfig(({ mode }) => ({
  base: mode === 'electron' ? './' : '/color-mix-lab/',
  plugins: [react()],
}))
