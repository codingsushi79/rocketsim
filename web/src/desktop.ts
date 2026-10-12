// Desktop shell integration (Tauri v2, `app.withGlobalTauri`): quit and fullscreen.
// In a plain browser these are no-ops (fullscreen falls back to the Fullscreen API).

interface TauriWindow {
  close(): Promise<void>;
  isFullscreen(): Promise<boolean>;
  setFullscreen(on: boolean): Promise<void>;
}
interface TauriGlobal {
  window: { getCurrentWindow(): TauriWindow };
}

function tauri(): TauriGlobal | null {
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

/** True when running as the desktop application. */
export const isDesktop = (): boolean => tauri() !== null;

export async function quitApp(): Promise<void> {
  await tauri()?.window.getCurrentWindow().close();
}

export async function toggleFullscreen(): Promise<void> {
  const t = tauri();
  if (t) {
    const w = t.window.getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  } else if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await document.documentElement.requestFullscreen().catch(() => {});
  }
}
