# dmgbuild settings for the Mac installer window (used by scripts/make-release.sh).
# Pass -D app=<path to Lectern.app> -D background=<path to background.png>.
# dmgbuild writes Finder's window layout itself, so no Finder scripting permission is needed.
import os.path

app = defines.get('app')  # noqa: F821  (dmgbuild provides `defines`)
background = defines.get('background')  # noqa: F821
app_name = os.path.basename(app)

# LZMA-compressed image (macOS 10.15 or later; Lectern needs 13). About a quarter smaller than zlib (UDZO)
# for the same app. compression_level only applies to zlib/bzip2 formats.
format = 'ULMO'
compression_level = 9
filesystem = 'HFS+'
files = [app]
symlinks = {'Applications': '/Applications'}

# The window is 660 x 400 points; the pixel art leaves these two spots clear.
window_rect = ((200, 140), (660, 400))
icon_size = 128
text_size = 13
icon_locations = {app_name: (165, 186), 'Applications': (495, 186)}
default_view = 'icon-view'
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False
arrange_by = None
