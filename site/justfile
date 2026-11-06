# Serves public/ at polylogue.agentics.lwirth.com, from lwirth-cloud,
# whose serve.nix in dotcloud says how. There is no build.
deploy:
    rsync -rlpt --delete --delay-updates --chmod=D755,F644 public/ root@lwirth-cloud:/srv/polylogue/
