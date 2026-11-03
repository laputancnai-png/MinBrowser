"""Click at screen coordinates with a real X11 mouse event (XTest).

Unlike Playwright's clicks, these go through the window system, so they hit
the browser's window drag regions exactly like a real mouse does.
Usage: python3 xclick.py X Y   (uses $DISPLAY)
"""
import ctypes
import ctypes.util
import sys
import time

x, y = int(sys.argv[1]), int(sys.argv[2])
xlib = ctypes.cdll.LoadLibrary(ctypes.util.find_library('X11') or 'libX11.so.6')
xtst = ctypes.cdll.LoadLibrary(ctypes.util.find_library('Xtst') or 'libXtst.so.6')
xlib.XOpenDisplay.restype = ctypes.c_void_p
display = xlib.XOpenDisplay(None)
if not display:
    sys.exit('cannot open display')
xtst.XTestFakeMotionEvent(ctypes.c_void_p(display), -1, x, y, 0)
xlib.XFlush(ctypes.c_void_p(display))
time.sleep(0.1)
xtst.XTestFakeButtonEvent(ctypes.c_void_p(display), 1, True, 0)
xlib.XFlush(ctypes.c_void_p(display))
time.sleep(0.05)
xtst.XTestFakeButtonEvent(ctypes.c_void_p(display), 1, False, 0)
xlib.XFlush(ctypes.c_void_p(display))
xlib.XCloseDisplay(ctypes.c_void_p(display))
