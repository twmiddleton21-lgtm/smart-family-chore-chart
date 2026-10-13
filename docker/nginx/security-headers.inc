# Security headers, included in every location block (nginx does not inherit
# add_header into a location that sets its own add_header).
#
# The app makes no network requests and loads no third-party resources, so
# the Content-Security-Policy only allows same-origin content. React sets
# inline styles through the CSSOM, which style-src 'self' permits.
# HSTS is left to the TLS-terminating proxy in front of this container.

add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
