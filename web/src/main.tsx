import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import './index.css';

// Pauses every CSS animation while the window is hidden (see [data-hidden] in index.css).
const markHidden = () => { document.documentElement.toggleAttribute('data-hidden', document.hidden); };
document.addEventListener('visibilitychange', markHidden);
markHidden();

// In the desktop shell the title bar is transparent and the page runs under it (see [data-shell] in index.css).
if ('__TAURI_INTERNALS__' in window) document.documentElement.dataset.shell = 'tauri';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
