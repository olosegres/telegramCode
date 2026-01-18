#!/bin/bash
set -e

TARGET_UID="${TARGET_UID:-501}"
TARGET_GID="${TARGET_GID:-20}"

# Create agent group and user if not exists
if ! getent group agent >/dev/null; then
    groupadd -g "$TARGET_GID" agent 2>/dev/null || groupadd agent
fi
if ! id -u agent >/dev/null 2>&1; then
    useradd -m -u "$TARGET_UID" -g agent -s /bin/bash agent 2>/dev/null || useradd -m -g agent -s /bin/bash agent
fi

# Update UID/GID if they changed (ignore errors if GID conflicts)
usermod -u "$TARGET_UID" agent 2>/dev/null || true
groupmod -g "$TARGET_GID" agent 2>/dev/null || true

# Initialize environment if not done yet (install claude)
if [ ! -f /home/agent/.initialized ]; then
    echo "First run: installing claude..."

    # Setup npm to install global packages in home dir
    mkdir -p /home/agent/.npm-global
    echo "prefix=/home/agent/.npm-global" > /home/agent/.npmrc

    # Add to PATH in bashrc
    echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> /home/agent/.bashrc

    # Install claude
    NPM_CONFIG_PREFIX=/home/agent/.npm-global npm install -g @anthropic-ai/claude-code

    touch /home/agent/.initialized
    echo "Initialization complete!"
fi

# Enable corepack for yarn berry
corepack enable

# Prepare volumes for agent user (volumes are created as root)
mkdir -p /workspace/node_modules/@biomejs
mkdir -p /workspace/node_modules/.bin
chown -R "$TARGET_UID:$TARGET_GID" /workspace/node_modules/@biomejs
chown -R "$TARGET_UID:$TARGET_GID" /workspace/node_modules/.bin

# Reinstall deps if .bin is empty (yarn doesn't populate mounted volumes on host install)
if [ -z "$(ls -A /workspace/node_modules/.bin 2>/dev/null)" ]; then
    echo "Populating .bin symlinks via yarn install..."
    su - agent -c "cd /workspace && yarn install" || true
    echo "Created $(ls /workspace/node_modules/.bin 2>/dev/null | wc -l) symlinks in .bin"
fi

# Copy git config from host if exists
if [ -f /tmp/host-gitconfig ]; then
    cp /tmp/host-gitconfig /home/agent/.gitconfig 2>/dev/null || true
fi

# Copy ssh keys from host if exists
if [ -d /tmp/host-ssh ]; then
    mkdir -p /home/agent/.ssh
    cp -r /tmp/host-ssh/* /home/agent/.ssh/ 2>/dev/null || true
    chmod 700 /home/agent/.ssh
    chmod 600 /home/agent/.ssh/* 2>/dev/null || true
fi

# Fix home directory ownership
chown -R "$TARGET_UID:$TARGET_GID" /home/agent

# Switch to agent user and run command
exec su - agent -c "export PATH=\"\$HOME/.npm-global/bin:\$PATH\" && cd /workspace && $*"
