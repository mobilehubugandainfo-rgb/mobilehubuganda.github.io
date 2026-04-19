# ============================================================
# MobileHub — MikroTik Auto-Kick & Sync Script
# File: mikrotik-sync.rsc
# Schedule: Every 5 minutes via /system scheduler
#
# What this does:
#   1. Calls your Cloudflare Worker /api/mikrotik/kick-expired
#   2. Gets back a list of voucher codes that have expired
#   3. Removes those users from MikroTik hotspot
#   4. Disconnects any active sessions for those users
#
# HOW TO INSTALL:
#   Copy this entire script into:
#   MikroTik > System > Scripts > Add New
#   Name: mobilehub-sync
#   Then set up scheduler (see bottom of file)
# ============================================================

:local workerUrl "https://mobilehubuganda.github.io/api/mikrotik/kick-expired"
:local logPrefix "[MobileHub]"

# ── Step 1: Call the Worker to get expired codes ─────────────────
:do {
    :log info "$logPrefix Checking for expired vouchers..."

    /tool fetch \
        url=$workerUrl \
        http-method=get \
        output=user \
        dst-path="/tmp/expired.txt"

    :local rawJson [/file get /tmp/expired.txt contents]
    :log info "$logPrefix Raw response: $rawJson"

    # ── Step 2: Parse the codes array from JSON ───────────────────
    # Worker returns: {"codes":["ABC123","DEF456"]}
    # We extract the value between [ and ]
    :local startPos [:find $rawJson "["]
    :local endPos   [:find $rawJson "]"]

    :if (($startPos = 0) && ($endPos = 0)) do={
        :log info "$logPrefix No expired vouchers found or bad response."
        /file remove /tmp/expired.txt
        :error "done"
    }

    :local codesStr [:pick $rawJson ($startPos + 1) $endPos]

    # If codes array is empty string, nothing to do
    :if ($codesStr = "") do={
        :log info "$logPrefix No expired vouchers at this time."
        /file remove /tmp/expired.txt
        :error "done"
    }

    # ── Step 3: Split codes by comma and kick each one ───────────
    # codesStr looks like: "ABC123","DEF456","GHI789"
    :local kicked 0

    :while ($codesStr != "") do={
        :local commaPos [:find $codesStr ","]
        :local code ""

        :if ($commaPos != "") do={
            :set code [:pick $codesStr 0 $commaPos]
            :set codesStr [:pick $codesStr ($commaPos + 1) [:len $codesStr]]
        } else={
            :set code $codesStr
            :set codesStr ""
        }

        # Strip surrounding quotes from "ABC123" → ABC123
        :set code [:pick $code 1 ([:len $code] - 1)]

        :if ($code != "") do={
            # ── Remove active hotspot session ──────────────────
            :do {
                /ip hotspot active remove [find user=$code]
                :log info "$logPrefix Kicked active session for: $code"
            } on-error={
                :log info "$logPrefix No active session for: $code (already offline)"
            }

            # ── Remove hotspot user account ───────────────────
            :do {
                /ip hotspot user remove [find name=$code]
                :log info "$logPrefix Removed hotspot user: $code"
                :set kicked ($kicked + 1)
            } on-error={
                :log info "$logPrefix User not found in hotspot (already removed?): $code"
            }
        }
    }

    :log info "$logPrefix Sync complete. Kicked $kicked expired user(s)."
    /file remove /tmp/expired.txt

} on-error={
    :log error "$logPrefix Script error — check Worker URL or network."
    :do { /file remove /tmp/expired.txt } on-error={}
}

# ============================================================
# SCHEDULER SETUP — Run this ONCE in terminal to install:
#
# /system scheduler add \
#     name="mobilehub-sync" \
#     interval=5m \
#     on-event="mobilehub-sync" \
#     policy=read,write,test \
#     comment="MobileHub auto-kick expired vouchers"
#
# CHECK LOGS WITH:
#   /log print where message~"MobileHub"
# ============================================================
