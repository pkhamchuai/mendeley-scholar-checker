#!/usr/bin/env python3
"""
Run this script to get your manifest.json "key" from your Extension ID.

Usage:
    python3 get_key.py <your-extension-id>

Example:
    python3 get_key.py abcdefghijklmnopqrstuvwx
"""

import sys, base64

def extension_id_to_key(ext_id):
    # Chrome extension IDs use a-p as hex digits (a=0, b=1, ..., p=15)
    hex_str = ''.join(format(ord(c) - ord('a'), 'x') for c in ext_id.lower())
    raw_bytes = bytes.fromhex(hex_str)
    key = base64.b64encode(raw_bytes).decode()
    return key

if len(sys.argv) < 2:
    print(__doc__)
    sys.exit(1)

ext_id = sys.argv[1].strip()

if len(ext_id) != 32 or not ext_id.isalpha():
    print("❌  That doesn't look like a valid Extension ID (should be 32 lowercase letters)")
    sys.exit(1)

key = extension_id_to_key(ext_id)

print(f"""
✅  Extension ID : {ext_id}
🔑  Key          : {key}
🔗  Redirect URL : https://{ext_id}.chromiumapp.org/

──────────────────────────────────────────────────
Add the "key" field to your manifest.json like this
(put it near the top, after "manifest_version"):
──────────────────────────────────────────────────

  "key": "{key}",

──────────────────────────────────────────────────
Make sure your Mendeley app's Redirect URL is set to:

  https://{ext_id}.chromiumapp.org/
──────────────────────────────────────────────────
""")
