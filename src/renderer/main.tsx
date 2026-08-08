import React from 'react'
import ReactDOM from 'react-dom/client'
import { MotionGlobalConfig } from 'framer-motion'
import App from './App'
import './index.css'

/**
 * Diagnostic kill switch for every animation in the UI — set CLUI_NO_ANIM=1.
 *
 * The launcher has no entrance animation of its own: nothing in the renderer
 * is gated on window visibility, and the shell deliberately suppresses its
 * mount animation. So this is a discriminator, not a fix. If a summon still
 * visibly jumps with every animation off, whatever moves is below the renderer
 * — the compositor or the window manager — and no animation tuning will help.
 *
 * Two separate systems have to be silenced. `skipAnimations` makes framer
 * resolve each animation straight to its final keyframe (checked before the
 * animation is even created, so AnimatePresence exits go instantly too), but
 * framer does not touch CSS, so the stylesheet's transitions and @keyframes
 * need overriding as well.
 */
if (window.__cluiNoAnim) {
  MotionGlobalConfig.skipAnimations = true
  const kill = document.createElement('style')
  kill.dataset.cluiNoAnim = ''
  kill.textContent = '*, *::before, *::after {'
    + ' transition: none !important;'
    + ' animation: none !important;'
    + ' }'
  ;(document.head ?? document.documentElement).appendChild(kill)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
