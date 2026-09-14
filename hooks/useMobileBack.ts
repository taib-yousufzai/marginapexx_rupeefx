import { useEffect, useRef } from 'react';

/**
 * A hook to intercept the mobile hardware back button and use it to close modals/overlays.
 * 
 * @param isOpen Whether the modal/overlay is currently open.
 * @param onClose Callback to fire when the user presses the hardware back button.
 * @param hash A unique hash string to identify this modal in the URL (e.g. 'chart', 'trade').
 */
export function useMobileBack(isOpen: boolean, onClose: () => void, hash: string = 'modal') {
  const closedByPopState = useRef(false);
  const onCloseRef = useRef(onClose);

  // Keep the latest callback without re-running the effect
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      closedByPopState.current = false;
      
      // Push a fake state to the history stack so the back button has something to pop
      const targetUrl = window.location.pathname + window.location.search + '#' + hash;
      
      // If we're already at this hash (e.g., opened twice quickly), don't push again
      if (window.location.hash !== '#' + hash) {
        window.history.pushState({ ...window.history.state, modal: hash }, '', targetUrl);
      }

      const handlePopState = (e: PopStateEvent) => {
        // Ignore popstate events triggered programmatically during modal state cleanup
        if ((window as any).__isProgrammaticBack) {
          return;
        }
        // Only close if the URL no longer contains our hash.
        // This prevents multiple modals from closing simultaneously on a single back press.
        if (window.location.hash !== '#' + hash) {
          closedByPopState.current = true;
          onCloseRef.current();
        }
      };

      window.addEventListener('popstate', handlePopState);

      return () => {
        window.removeEventListener('popstate', handlePopState);
        
        // If the modal is closing, but NOT because the user pressed the back button
        // (e.g., they clicked an "X" button, backdrop, or opened another sheet), clean up
        // the history stack so the fake state doesn't stay there.
        if (!closedByPopState.current && window.location.hash === '#' + hash) {
          (window as any).__isProgrammaticBack = true;
          window.history.back();
          setTimeout(() => {
            (window as any).__isProgrammaticBack = false;
          }, 150);
        }
      };
    }
  }, [isOpen, hash]);
}
