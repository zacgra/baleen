FROM debian:bookworm-slim

ARG USERNAME=baleen

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  curl \
  wget \
  git \
  ripgrep \
  findutils \
  sed \
  diffutils \
  patch \
  jq \
  less \
  procps \
  unzip \
  sqlite3 \
  sox \
  libsox-fmt-pulse \
  pulseaudio-utils \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash $USERNAME
USER $USERNAME

# Install bun (JavaScript runtime and package manager)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/$USERNAME/.bun/bin:$PATH"

# Install uv (Python package manager — also provides python)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/home/$USERNAME/.local/bin:$PATH"

# Install Claude Code via native installer (into user home)
RUN curl -fsSL https://claude.ai/install.sh | bash

# Copy binary and init script to system paths so they survive the runtime tmpfs overlay on $HOME
USER root
COPY sandbox-init.sh /usr/local/bin/sandbox-init
RUN cp /home/$USERNAME/.local/bin/claude /usr/local/bin/claude \
  && cp /home/$USERNAME/.local/bin/uv /usr/local/bin/uv \
  && cp /home/$USERNAME/.bun/bin/bun /usr/local/bin/bun \
  && chmod 755 /usr/local/bin/claude /usr/local/bin/uv /usr/local/bin/bun /usr/local/bin/sandbox-init
USER $USERNAME

WORKDIR /sandbox

ENTRYPOINT ["sandbox-init"]
