<p align="center">
  <img src="straggler/desktop/src-tauri/icons/icon.png" alt="Straggler logo" width="96" height="96">
</p>

# Straggler

Chat with local AI models on your Mac or Linux computer. Straggler manages
llama.cpp from the desktop app. Projects let you share instructions and documents
across chats.

Straggler takes its name from
[blue stragglers](https://science.nasa.gov/missions/hubble/hubble-sees-an-unexpected-population-of-young-looking-stars/),
stars that appear bluer and younger than their neighbors in a star cluster.

## Download

Straggler 1.0.0 is available for these platforms:

| Platform | Download |
| --- | --- |
| macOS 13.5+ · Apple Silicon (ARM64) | [Download for Mac](https://github.com/etufarini/Straggler/releases/download/straggler-v1.0.0/Straggler-1.0.0-macos-arm64.dmg) |
| Linux · Ubuntu 24.04+ · x86-64 (amd64) | [Download for Ubuntu](https://github.com/etufarini/Straggler/releases/download/straggler-v1.0.0/straggler_1.0.0_amd64.deb) |

Verify your download against [SHA256SUMS](https://github.com/etufarini/Straggler/releases/download/straggler-v1.0.0/SHA256SUMS)
using `shasum -a 256 <file>` on macOS or `sha256sum <file>` on Ubuntu.
See the [release notes](https://github.com/etufarini/Straggler/releases/tag/straggler-v1.0.0)
for package details. **The macOS download is ad hoc signed and is not notarized;
Gatekeeper may block opening it.**

On macOS, open the DMG, drag Straggler to Applications, then open it there. On
Ubuntu, run `sudo apt install ./straggler_1.0.0_amd64.deb`, then open Straggler from
the application menu.

llama.cpp is included. Models are separate: download a GGUF model in the app or
choose one you already have. You need enough memory to load it. Installing the
app requires no Node.js, Rust or compilation.

[<img src="straggler/docs/screenshots/desktop-chat.png" alt="Straggler 1.0.0 chat before selecting a model" width="960">](straggler/docs/screenshots/desktop-chat.png)

## Your first chat

1. In **Settings → Model files**, select **Choose existing folder** for your GGUFs,
   or **Create models folder**. To download a model, open **Models → Hugging Face**.
2. In **Model settings**, choose a model and review its settings. Select **Apply
   changes**, then **Back to chat**.
3. Select **Launch server**, wait for **Ready**, then send a message.

The model selector and server controls stay at the top of chat. **Stop response**
keeps the text received so far; **Stop server** shuts down llama.cpp.

## CPU and GPU support

Both packages support CPU inference. The macOS Apple Silicon backend also includes
Metal GPU support. The Ubuntu backend is CPU-only.

For GPU acceleration on Linux, we recommend compiling an external llama.cpp build
for your hardware: CUDA for a compatible NVIDIA GPU, or Vulkan for a GPU with
compatible Vulkan drivers. Select it in **Settings → llama.cpp → Choose external
build**. Available devices and options depend on that build; GPU drivers are
installed separately. The guide below covers setup and switching back.

## Development

After installing the development prerequisites described in the guide, run from
the repository root:

```bash
npm --prefix straggler/desktop ci
npm --prefix straggler/desktop run desktop
```

Straggler is written for humans to read, maintain, and improve.

See the [user and developer guide](straggler/docs/guide.md) for GPU setup, chat,
files, projects, saved configurations, backups, troubleshooting and development.
