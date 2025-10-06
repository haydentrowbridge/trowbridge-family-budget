import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// ⬇️ Import the compiled Tailwind CSS, NOT index.css
import './tw.output.css'

import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
