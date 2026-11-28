# Straggler user and developer guide

Straggler lets you chat with local GGUF models and keep related conversations and
files in projects. It manages a llama.cpp server on your computer; llama.cpp loads
the model and generates responses. You choose when to start and stop it.

For a first session, begin with [Getting started](#getting-started). For a specific
question, use the sections below:

- [Getting started](#getting-started): requirements, startup and your first chat.
- [CPU and GPU support](#cpu-and-gpu-support): included backends and external
  CUDA or Vulkan builds on Linux.
- [Chat and conversations](#chat-and-conversations): prompts, reasoning, editing
  and conversation exports.
- [Working with files and projects](#working-with-files-and-projects): document
  support, shared instructions and context limits.
- [Settings reference](#settings-reference): each Settings section, defaults and
  when changes take effect.
- [Server controls and troubleshooting](#server-controls-and-troubleshooting):
  logs, shutdown and recovery from errors.
- [Data, backups and compatibility](#data-backups-and-compatibility): storage,
  backups, older settings and environment controls.
- [Development and architecture](#development-and-architecture): local setup,
  checks and code responsibilities.
- [Packaging and releases](#packaging-and-releases): published downloads, native
  package preparation and signing.

## Getting started

### What you need

Straggler 1.0.0 has published packages for macOS 13.5+ on Apple Silicon (ARM64)
and Ubuntu 24.04+ on x86-64 (amd64), with a graphical session. The Ubuntu package
requires glibc 2.39 and its declared GTK/WebKitGTK libraries; a DEB package does
not imply compatibility with every Debian-based distribution. Other build targets
are described under [Building packages](#building-packages). Windows is not a
supported native target.

You also need a GGUF model file supported by your selected llama.cpp backend and
enough memory to load it. GGUF is the model file format Straggler looks for in
your models folder. Model weights are supplied separately. You can open the app,
review its settings and develop it without a model or a running inference service.

Both published packages support CPU inference. The macOS Apple Silicon backend
also includes Metal; the Ubuntu backend is CPU-only. GPU support depends on the
selected backend and its drivers. See [CPU and GPU support](#cpu-and-gpu-support)
for external builds on Linux. Memory estimates cannot guarantee that a model
will fit.

### Open the app

Download a package from [Straggler 1.0.0](https://github.com/etufarini/Straggler/releases/tag/straggler-v1.0.0)
and verify it against the accompanying `SHA256SUMS`. The macOS download is ad hoc
signed, without Developer ID signing or notarization; Gatekeeper may block opening
it. See [Published downloads](#published-downloads) for direct links and verification.
GitHub's automatic source archives are not desktop installers.

Packages include a pinned llama.cpp backend. Install and open them as follows:

| Platform | Install and open |
| --- | --- |
| macOS | Drag Straggler from the disk image to Applications, then open it there. |
| Ubuntu | Install the `.deb` with your package manager, then open Straggler from the application menu. |

Installed startup does not compile code or download tools. Packages need no Bash,
Python, Node.js or Rust toolchain at runtime. Linux packages depend on system
libraries, including WebKitGTK and GTK. Models and GPU drivers remain separate.

To run from source, follow [Local development](#local-development). Source sessions
have no bundled backend unless one has been explicitly prepared.

### Configure your first chat

1. In **Settings → Model files**, select **Choose existing folder** for your GGUF
   files, or **Create models folder** to create a folder in the Tauri app data directory.
   The system picker saves the selection only when you accept it; cancellation
   keeps the previous folder. Straggler searches two subfolder levels. An empty
   folder is valid; use **Models → Hugging Face** to download a model explicitly.
2. In **Model settings**, choose a model. Review context size, memory format and
   server settings, then select **Apply changes**. Review **Chat defaults**
   separately for reply settings. The [settings reference](#settings-reference)
   explains the controls.
3. Select **Back to chat**, then **Launch server**. Wait for the status to change
   from **Loading** to **Ready**. On the first launch, the message field receives
   keyboard focus if you have left focus on the launch control. If startup fails,
   open the status badge for the log and follow
   [troubleshooting](#server-controls-and-troubleshooting).
4. Type a message and select **Send message**. The response appears in the chat.
   Select **Stop response** if you want to stop generation and keep the text
   received so far.

Packages use their included backend by default. For a source session, choose an
existing llama.cpp build in **Settings → llama.cpp** before launching the server;
the folder must contain `build/bin/llama-server` or `bin/llama-server`. If a packaged
backend is unavailable, follow [troubleshooting](#other-common-problems).

Models use the system folder picker on both platforms. Hidden folders remain
accessible through the picker’s hidden-file control or path entry. Flatpak uses
the FileChooser portal directly. External backend selection uses the existing
folder browser; **Use this folder** accepts it and **Cancel** preserves the path.

To reuse the model and server settings later, save a configuration under
[Saved configurations](#saved-configurations). Conversations are stored separately.

### Find your way around

The top of chat keeps the model selector, server status and server controls
accessible. Open the model selector to search, choose or refresh models; **Use model**
starts the server with that selection. Select the server status badge to read its
log. Use the sidebar for conversations, projects and Settings.

Sidebar and assistant-panel expansion are remembered as desktop preferences,
separately from saved configurations and browser preferences. The assistant
animation reflects response state; it does not measure inference speed or prove
hardware readiness. Visual detail adapts to rendering cost to leave time for chat
updates. The animation pauses while the window is hidden and respects the system
reduced-motion preference.

### Update or remove the app

Close Straggler before replacing its package. Application updates include backend
updates; you can also select an existing external build in **Settings → llama.cpp**.
Remove the app through the operating system. Personal settings, conversations,
models and external backends are separate from the application payload. See
[Back up your data](#back-up-your-data) before moving or removing personal files.

## CPU and GPU support

Straggler manages the backend process; llama.cpp discovers devices and performs
inference. The published 1.0.0 packages include llama.cpp `b12248`, source commit
`3837bf0bc02ea5d08f8ee3585fc8c7784a81bce8`.

| Published package | Included backend | GPU setup |
| --- | --- | --- |
| macOS Apple Silicon | CPU and Metal | Metal support is included; select from the devices advertised by the backend. |
| Ubuntu x86-64 | CPU-only | Select an existing external CUDA or Vulkan build for compatible hardware and drivers. |

In **Model settings → Speed**, **CPU only** disables GPU layers.
**Auto** lets llama.cpp choose from its available devices. Device availability,
model compatibility and performance depend on the selected backend, model and
hardware. Automated application and packaging checks verify contracts, resources
and backend identity without model weights; they do not establish real inference
or GPU performance on every computer.

### Choose a Linux GPU backend

For GPU acceleration on Linux, we recommend compiling llama.cpp for the hardware
and drivers on that computer:

- **CUDA:** use a supported NVIDIA GPU, compatible NVIDIA driver and CUDA Toolkit,
  and a host compiler supported by that Toolkit. Follow the
  [NVIDIA Linux installation guide](https://docs.nvidia.com/cuda/cuda-installation-guide-linux/)
  and [llama.cpp CUDA instructions](https://github.com/ggml-org/llama.cpp/blob/b12248/docs/build.md#cuda).
  Choose versions that support your GPU; the newest Toolkit is not necessarily
  appropriate for older hardware.
- **Vulkan:** use a GPU and driver supported by llama.cpp's Vulkan backend. Follow
  the [llama.cpp Vulkan instructions](https://github.com/ggml-org/llama.cpp/blob/b12248/docs/build.md#vulkan)
  for the SDK or system development packages. On Ubuntu these include
  `libvulkan-dev`, `glslc` and `spirv-headers`. Install `vulkan-tools` for
  `vulkaninfo` and check that it reports the intended GPU before compiling.
  A software Vulkan device does not provide GPU acceleration.

These are optional backend development steps. They do not require rebuilding
Straggler. The installed app does not install drivers, SDKs or compilers.

### Compile an external llama.cpp backend

Install Git, CMake and a C/C++ build toolchain, plus the prerequisites for the
chosen backend. The [upstream build guide](https://github.com/ggml-org/llama.cpp/blob/b12248/docs/build.md)
is the reference for platform dependencies. The examples below use the same
`b12248` release as Straggler 1.0.0 and separate directories for each backend.
Choose one example.

For CUDA, after installing a compatible driver, Toolkit and compiler:

```bash
git clone --branch b12248 --depth 1 https://github.com/ggml-org/llama.cpp.git llama.cpp-cuda
cmake -S llama.cpp-cuda -B llama.cpp-cuda/build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON
cmake --build llama.cpp-cuda/build --config Release --target llama-server
```

For Vulkan, after installing its build dependencies and verifying `vulkaninfo`:

```bash
git clone --branch b12248 --depth 1 https://github.com/ggml-org/llama.cpp.git llama.cpp-vulkan
cmake -S llama.cpp-vulkan -B llama.cpp-vulkan/build -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=ON
cmake --build llama.cpp-vulkan/build --config Release --target llama-server
```

Keep the build directory and its libraries together. Do not copy only
`llama-server` into another directory. You can inspect the resulting backend
without a model by running, for the chosen build:

```bash
./llama.cpp-cuda/build/bin/llama-server --version
./llama.cpp-cuda/build/bin/llama-server --list-devices
```

Replace `llama.cpp-cuda` with `llama.cpp-vulkan` for the Vulkan example. These
commands inspect llama.cpp; start and stop chat servers from Straggler.

Later llama.cpp releases can be selected as external builds. Follow the build
instructions for that release and review its advertised capabilities; this
example does not establish compatibility with every later version or model.

### Select the backend in Straggler

1. Stop the current server, then open **Settings → llama.cpp**.
2. Select **Choose external build** and browse to `llama.cpp-cuda` or
   `llama.cpp-vulkan`, then accept with **Use this folder**. Choose the root
   folder containing `build/bin/llama-server`, rather than the executable itself.
   A packaged external build containing `bin/llama-server` is also accepted.
3. Review the backend details. In **Model settings**, choose from its advertised
   devices and options, then select **Apply changes**.
4. Return to chat and select **Launch server**. Read the server log if startup
   fails or the expected device is unavailable.

To use CPU inference with the selected backend, choose **CPU only** in Model
settings and apply the change. To restore the package's original backend, stop
the server and select **Use bundled version** in **Settings → llama.cpp**, confirm
with **Use bundled version**, then review Model settings before restarting. The
bundled Ubuntu backend is CPU-only.

## Chat and conversations

### Start a chat and set its instructions

Select **New chat** in the sidebar for a conversation outside any project. To
start a chat with shared instructions and files, open a
[project](#create-and-organize-projects) instead. Send with Enter or **Send
message**; use Shift + Enter for a new line.

To set instructions for this chat:

1. Open **System prompt** beside the message box.
2. Choose **Default** to inherit the applied Settings prompt, or **This chat** to
   enter your own instructions.
3. Select **Apply to this chat**. The change applies from the next message,
   without restarting the server.

An explicitly empty custom prompt sends no system message. Project chats use
their project's instructions, as described under
[Shared instructions](#shared-instructions).

### Format a message

The message field shows formatting as you type, in chats, temporary chats,
project starts and user-message edits. The **Aa** control shows or hides its
formatting toolbar; this desktop preference also applies when editing messages.
The field becomes editable after a model is loaded.

Use the toolbar for bold, italic, strikethrough, links, numbered or bulleted lists,
quotes, inline code and code blocks. Typing `*bold*` or `**bold**`, `_italic_`,
`~struck~` or `~~struck~~`, or backtick-delimited code converts the text on the
closing symbol. At the start of a line, `1. `, `- ` or `* `, `> ` and three
backticks start their corresponding block. Undo immediately restores the symbols.
Code and symbols inside words remain literal.

Pasting inserts plain text. Press Ctrl/⌘+Shift+F to apply standard Markdown
formatting explicitly. Links accept HTTP and HTTPS; a domain without a scheme
gets `https://`. Email addresses and other protocols show a validation error.
Pasting a URL over selected text adds a link. Links open outside the application
only after the message has been sent.

Enter sends, and Ctrl/⌘+Enter sends from any block. Shift+Enter adds a line, or a
new list item; on an empty list item or quote line it exits that block. Tab and
Shift+Tab indent and outdent lists; elsewhere Tab moves focus. Inside code blocks,
Enter adds a line and exits on an empty last line. Arrow Down at the end of the
last code block creates a paragraph below it. Backspace at the start of a quote
or code block returns it to ordinary text.

Toolbar tooltips include shortcuts. Ctrl/⌘+B and I toggle bold and italic;
Ctrl/⌘+Shift+X, U, 7, 8, 9 and C select strikethrough, link, numbered list,
bulleted list, quote and inline code. Add Alt to the code shortcut for a code block.
Underline is not supported. In user-message edits Enter still adds a line;
use **Save and regenerate** or Ctrl/⌘+Enter to save, and Escape to cancel.
Assistant-response edits remain a Markdown textarea.

Messages are sent and saved as standard Markdown in the existing conversation
format. User messages preserve single line breaks; assistant rendering is unchanged.

### Temporary chats

On an empty chat outside a project, choose **Temporary** or press Ctrl/⌘+Shift+N.
The empty-sky appearance marks the session. Messages and attachment originals
stay in memory: no conversation history, search entries, project association or
draft is written. Exports and attachment downloads are available after saving.
**Save chat** creates a normal conversation, including its attachment originals.
If saving fails, the temporary session remains available for retry.

New chat, another conversation, Settings and native window close ask before
leaving. Choose to stay, **Save chat**, or erase the temporary conversation.
Closing the application also confirms server shutdown and pauses downloads.

If a server is running, starting a temporary session restarts it with advertised
`--slots --cache-ram 0 --log-disable`; unsupported external builds are refused.
Temporary requests use `cache_prompt: false` and an explicitly discovered slot.
On exit Straggler erases that slot and stops the owned process, releasing its RAM;
the normal server restarts for continued use unless the app is closing. Raw
private backend output and HTTP error bodies are not retained in app logs.
For the pinned backend, disabling `cache_prompt` alone does not prevent its global
RAM prompt cache from retaining data; disabling cache RAM and ending the process
are therefore required.

### Use an optional cloud model

Cloud service status chips distinguish **Not set up**, **Key saved** and **Couldn’t read key**. **Tested with Straggler** is a tooltip for built-in integrations, not verification of your account or its current connectivity.

Local chat works offline. To use a cloud service, open **Settings → Cloud models**,
enter your own API key and choose **Save and verify**. This explicitly requests the
service’s model list. A rejected replacement keeps the previous key. Keys live only
in the system keychain; provider addresses, cached model metadata and **Models to
show** are stored separately without credentials. **Refresh models** makes another
explicit request. Custom providers must use HTTPS, except HTTP on loopback, and
redirects are not followed. Custom services use the OpenAI Chat Completions format
and are not tested by Straggler.

In the model selector, select a model under **Cloud · ‹service›** and choose **Use
model**. This stops only the llama.cpp process owned by Straggler and frees its
memory. Choose **On this computer → Use model** to return to local inference.
Selection lasts for this app session; provider setup and visible models are saved.
Chat defaults also apply to cloud models; unsupported generation parameters are omitted. Capabilities and context capacity
appear only when the service declares them; missing capabilities remain unknown.

Before the first message to each service, **Continue** acknowledges that the chat
history, applicable project instructions/files and included attachments leave this
computer. Cancel preserves the draft and sends nothing. The service’s terms apply.
The model header and composer identify the destination on every message. Cloud
chat supports projects, attachment search, web search and branches. Unsupported
images are explicitly excluded. **Stop response** cancels generation and retains
partial text. Usage and cost appear only when reported by the service.

Temporary cloud chats stay in memory and are not saved on this computer, but their
messages still go to the selected service. Export keeps the existing conversation
version 1 format and contains no keys. No cloud request runs at startup or merely
by opening Settings or the model selector.

### Compact a long chat manually

Choose **Compact chat** from the open chat’s menu or the **Context** popover. At
75% of the context capacity, a reminder offers the same action; **Dismiss** hides
that reminder for this chat until the app restarts. Nothing compacts automatically.
When a draft exceeds the available context, **Compact and continue** keeps the draft,
summarizes earlier messages and sends it after success. If you edit the draft while
the summary is being generated, Straggler keeps it for review instead of sending it.

The active local or cloud model summarizes older turns in bounded blocks. Recent
exchanges remain whole, with roughly 25% of known capacity reserved for them; with
unknown capacity, the latest four messages are kept. The previous summary is included
when compacting again. Original messages, files and project instructions stay saved;
files retain their own context/search settings. Reasoning is not summarized. Cloud
compaction uses the same first-send acknowledgement and sends the earlier message
text to that service. No web search or tools run during compaction.

**Stop response** cancels generation without changing the chat. Completed summaries
are committed through normal atomic storage; storage errors keep the previous chat.
The divider **Earlier messages summarized** opens the summary. Its menu offers
**Edit summary** in raw Markdown and **Remove summary** to use original messages again.
Editing or regenerating a covered message removes the summary and announces why.
A branch strictly after the divider copies the summary; a branch before it does not.
Exports still include the original messages in conversation version 1, without the
summary. Temporary-chat summaries remain in memory until explicit **Save chat**.

Compaction is unavailable during another chat operation, in archived projects or
with fewer than four messages. Open the chat before compacting it from its menu.
When capacity is unknown, more than four messages are needed to leave older text
to summarize. Messages themselves or project instructions can still exceed capacity;
compaction does not silently discard them.

### Use reasoning controls

The reasoning and effort controls beside the message box depend on what the
running model's chat template advertises. Unsupported requests are reported
explicitly. Separate reasoning appears only when the server returns it; it may
not be available for every model or backend. Changes apply to the next message.

Dragging files into the window highlights the composer with **Drop to attach**, as
well as the existing right-panel dropzone. The composer remains visible when that
panel is collapsed. **Attach · 2** shows the number of attached files in the chat;
failed or still-reading uploads are not counted as attached. Accepted formats,
size limits and validation remain unchanged.

### Edit or regenerate a response

Use the actions beside a message to copy or edit its text. A user message also
provides **Regenerate response**. Editing a user message and choosing **Save and
regenerate**, or regenerating an earlier turn, removes the later turns. The editor
or confirmation explains this before the change is saved.

Assistant responses can be edited as Markdown and saved with **Save response**.
Reasoning stays read-only. If saving fails, the editor and the previously saved
response remain available so you can retry.

**Stop response** ends the current generation and preserves partial text. An
interrupted response also keeps the text received so far. Request errors stay
with the response; open **Technical details** for the original diagnostic.

### Reopen or delete a conversation

Select a conversation in the sidebar to reopen it. To delete it, open its menu,
choose **Delete**, then review the **Delete chat** confirmation. This
permanently removes the conversation and its stored attachments from this device;
original source files remain untouched. Export or back up anything you want to keep
before confirming.

### Export or import a conversation

Open a conversation's menu, select **Export chat…** or **Export with reasoning…**,
and choose a destination in the native Save panel. The export includes the
effective system prompt at export time. It does not include attachments, project
files or metadata, statistics, or other request options. Use a
[full data backup](#back-up-your-data) to preserve those stored files and records.

To import, select **Import** beside the sidebar's conversation list and choose a
JSON file. Each import creates a new conversation outside projects; it never
merges with or replaces existing history. Invalid files leave stored history
unchanged. See [Conversation export format](#conversation-export-format) for
accepted JSON formats.

## Working with files and projects

### Add documents to a conversation

Open the assistant panel beside chat and select **Add files** under **Attachments**,
or drop files onto the native app window. If the panel is collapsed, use **Expand
assistant panel** to open it. Straggler extracts text and includes each
attachment in every request for that conversation, in insertion order and labelled
with its filename. Original source files remain untouched.

Straggler stores a copy of each attachment and its extracted text. **Download**
works even after the source file has moved. **Remove** deletes the stored copy and
text; deleting a conversation removes its attachments too. A failed read remains
visible for removal without becoming a saved attachment.

### Supported files and extraction limits

The limit is 10 MiB per file, shown as **10 MB** in the interface. The same formats
and size limit apply to conversation attachments and project files.

| Format | Text used in requests |
| --- | --- |
| UTF-8 `.txt`, `.md` | Plain text content |
| `.docx` | Document text |
| `.xlsx` | Spreadsheet sheets; uncached formula results are excluded |
| `.pptx` | Text in the presentation's declared slide order |
| `.pdf` | Extractable text in page order; the file must be unlocked |

Images and formatting are excluded. Straggler performs no OCR, so scanned PDFs
need a text layer. Legacy Office formats, CSV and OpenDocument are unsupported.

### Create and organize projects

Projects group conversations around shared instructions and documents. For
example, a project can keep the same reference documents available to several
chats without adding them to each conversation separately.

1. Select **Projects → New** or **All projects → New project**.
2. Give the project a name. Names are required, unique ignoring case and limited
   to 80 characters; an optional description allows 200 characters.
3. Open the project to add instructions and files, then start a chat there.

Star a project to pin it in the sidebar. **All projects** supports search, sorting
and **Active**/**Archived** tabs. Sidebar **New chat** always starts outside projects.

### Shared instructions

Project instructions replace the system prompt of every member chat. Empty project
instructions fall back to the applied Settings default. The prompt chip in a
project chat edits those shared instructions.

A chat's own prompt is preserved while it belongs to a project and restored when
it leaves. Moving a chat explains any prompt change before confirmation. For
example, a chat with its own prompt uses the project's instructions after moving
in, then recovers its own prompt after moving out.

### Shared files and context limits

Add files from the project view. Included files are sent in full after the project
instructions, in stable order. Turn off a file's **Include** switch to leave it
stored without sending it. Straggler has no retrieval index and does not
select excerpts automatically.

The context window is the token budget shared by instructions, files, conversation
and replies. A token is a unit of text counted by the backend. Adding documents
uses part of this budget before the model can answer.

| Indicator | What it measures and what happens at the limit |
| --- | --- |
| Chat context counter | Estimates the current prompt and draft against the running server's `n_ctx`. Sending is blocked when the prompt exceeds known capacity; preflight also checks the assembled request. |
| Project meter | Reserves 25% of the running context for conversation and replies. It warns at 75% of the remaining project budget and blocks new chats and sending above 100% of that budget. |

The chat counter uses the running server's capacity, rather than a draft setting
or the model's training context. Backend tokenizer/template counts are used where
available. Approximate counts are marked; the project meter uses **≈** for a
fallback estimate of four characters per token.

If capacity is unknown, it is shown as unavailable and sending remains possible;
the backend can still reject the request. Straggler never silently truncates
content. To make room, exclude or remove files, or apply a larger supported
context and restart the server. A larger context may require more memory.

### Change, archive or delete a project

Changes to instructions or included files during generation apply to the next
request. The current request keeps its original snapshot. Moving or removing the
generating chat, or archiving or deleting its project, waits until the response
finishes or stops. You can still manage other chats.

Archived projects are read-only until restored. Moving or removing chats, removing
project files, archiving and restoring offer a brief **Undo** action. Confirmed
project deletion is permanent. The deletion dialog lets you choose whether to
delete chats too; by default, chats remain outside the project with their own
prompts restored.

Conversation exports include the effective prompt but omit project files and
metadata. To keep an entire project and its files, use a
[data backup](#back-up-your-data).

## Settings reference

Settings opens **Overview** the first time and reopens the last section used during the session. Overview shows the current applied setup using already known application state. Its cards open the matching section; **Needs attention** identifies a missing local model or backend. Opening Overview does not contact external services.

After Overview, Settings has three groups, in this order:

- **All models:** Chat defaults and System prompts.
- **On this computer:** Model settings, llama.cpp and Model files.
- **Cloud and web:** Cloud models and Web search.

The **Models** panel has one searchable list, grouped by destination. Search filters
only models and services already loaded. The current model says **In use**; the
note below explains the selected model’s destination or memory estimate.
**Download models…** opens Hugging Face in a secondary view; **Back to models**
returns focus to that action. Downloads remain visible in either view. Opening
Models focuses **Search models**, and Escape closes the panel.

Cloud chat uses muted plum surfaces with orchid controls. The cloud icon, service
badge and **Sent to ‹service›** note identify the destination alongside color.
Response headers identify **Generated on this computer** or **Generated by
‹service›** through their icon label and tooltip.

### Apply, save and restart

Settings distinguish the values you are editing, the saved configuration and the
configuration used by the running server:

| Label | Meaning | What to do |
| --- | --- | --- |
| Unapplied changes | Edited values differ from the applied session settings. | Select **Apply changes** to validate and apply them. |
| Modified | Edited values differ from the associated saved configuration. | Save to that configuration, or save a new one, to keep the changes. |
| Restart required | Server launch settings differ from the running configuration. | Stop and launch the server to use the new values. |

When no saved configuration is associated, the heading reads **Custom settings**.
The status tooltips explain the next action:

- **Modified:** “Differs from the saved configuration. Save it to keep these values.”
- **Unapplied changes:** “Select Apply changes to use these values.”
- **Restart required:** “Stop and launch the server to use the new values.”

**Apply changes** does not save a named configuration or restart the server.
Saving a configuration also applies the edited server values. Chat defaults save
automatically and apply from the next message, without restarting. Loading a configuration
returns to **Model settings** for review; start the server when you are ready.
Folders are saved separately after you accept and validate a directory.

### Model settings

[<img src="screenshots/desktop-settings.png" alt="Straggler 1.0.0 model settings before choosing a GGUF" width="960">](screenshots/desktop-settings.png)

One draft and one **Apply changes** row cover **Model**, **Memory**, **Speed** and **Server**. The page index opens each group and focuses its first control. The navigation dot identifies unapplied changes. A changed saved field also says **Changed · was ‹value›** beside an amber margin marker. The header stays visible with a consistent background while the fields scroll in a separate area below it; anchor targets remain visible in that area.


Choose the GGUF, chat template, context size, K/V memory format and default
reasoning effort for the model on this computer in this section. A supported model can still exceed available memory or use a
chat template unsupported by the backend. Straggler does not infer model support
from filenames.

**Chat template** defaults to the template embedded in the GGUF. Select
**Custom file…** to choose a local Jinja template with any filename. Selecting
it enables the override; choose **Default** to stop using it. A
`chat_template.jinja` beside the selected GGUF is offered as **Use this file**,
but is never loaded automatically. The selected filename is shown; expand it
to inspect the full path.

The custom template must be readable, nonempty UTF-8 text without NUL characters,
up to 2 MiB. The selected backend must advertise `--jinja` and
`--chat-template-file`. Straggler passes the selected file without editing it or
the GGUF; llama.cpp owns Jinja parsing and model compatibility. A missing or
invalid selected file stops launch instead of silently using another template.
Reasoning, effort and tool controls still use the loaded template's
backend-reported capabilities.

Template and MTP selections are saved in configurations and participate in
**Modified** and **Restart required**. Selecting a different model manually
resets both to their defaults; loading a saved configuration restores the model
and its selections together, without launching. Stop and launch the server to
apply changes. Editing a file's contents outside Straggler also requires a
restart; content changes are not tracked by these indicators. Saved configurations
reference external files rather than copying or embedding their contents.

Native `LLAMA_ARG_CHAT_TEMPLATE` or `LLAMA_ARG_CHAT_TEMPLATE_FILE` overrides retain
precedence, including explicit empty values. The control identifies the override
variables and is disabled while they are present. Straggler passes the native
environment through unchanged.

| Control | Meaning and default |
| --- | --- |
| Context size | **Auto** lets llama.cpp choose. **Largest the model supports** stores `0` and requests full model context. A positive token count requests an explicit size. Input and output share the context. |
| Keys format / Values format | K/V cache formats default to `q4_0`. Choices come from the selected server's help. Quantized V may require Flash Attention; llama.cpp reports model/backend restrictions. |
| Default effort for this model | Levels come from the loaded model’s chat template. The default is **Template default**. Apply changes saves this local default without requiring restart; a chat can override it from the message box. Cloud effort is chosen per chat. |

### Chat defaults

This is the first section in **All models**. System prompt, reasoning, reply style,
seven sampling values, seed and longest reply apply to models on this computer and
in the cloud. New chats inherit the default system prompt; chats can override
system prompt and reasoning from the message box. Reasoning applies only when the
model advertises it. Default reasoning effort remains local in **Model settings**.

Choices save immediately. Text and numeric fields save when they lose focus and
after 600ms without typing. Invalid text stays visible with its validation error
and is not saved. Storage failures keep the edit and provide **Technical details**.
Auto-save writes only chat defaults; it preserves unapplied model, performance and
port changes and never restarts or modifies the running server configuration.

**Reply style** selects a preset; **Fine-tune reply style** exposes individual
values in one column. **Seed** accepts Auto, -1 (random where supported), or an
unsigned 32-bit integer. A fixed seed does not guarantee identical output across
devices or services. **Longest reply** accepts Auto, -1 (no explicit limit), 0
(local prompt evaluation only), or a positive token count. Cloud requests omit
nonpositive token limits so the service can choose its default.

Straggler sends non-Auto numeric generation values with every request. They are
not llama-server launch arguments and do not require restart. A compaction request’s
output limit takes precedence over the default. Unsupported fields are omitted:

| Parameter | Local llama.cpp | OpenRouter | DeepSeek | Mistral | Custom service |
| --- | --- | --- | --- | --- | --- |
| temperature, top_p, presence_penalty, frequency_penalty | Yes | Yes | Yes | Yes | Yes |
| top_k | Yes | Yes | No | Yes | No |
| min_p | Yes | Yes | No | No | No |
| repeat_penalty | Yes | repetition_penalty | No | No | No |
| seed | Yes | Yes | No | random_seed | Yes |
| max_tokens | Yes | Yes | Yes | Yes | Yes |

For OpenRouter, an advertised `supported_parameters` list further restricts the
request; without a list, the service table applies. Missing or unknown telemetry
does not imply support. DeepSeek ignores temperature and penalties while thinking;
its current endpoint documentation also deprecates penalties. Services may impose
additional value ranges. Custom-service support follows the OpenAI-compatible
contract and must be verified with the selected service.

The contract was checked against the pinned llama.cpp **b12248** API parser and
request task source, [Mistral Chat Completion](https://docs.mistral.ai/api/endpoint/chat)
(including `top_k`), [OpenRouter parameters](https://openrouter.ai/docs/api/reference/parameters)
and [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/).
No inference service is contacted by automated checks.

A field shows an exception note only when a configured service does not accept it:
**This computer only**, **Not sent to ‹service›**, or the shorter supported-service
list. No configured services means no exception notes. OpenRouter counts as
supported here; its per-model filter is applied when sending.

The sampling presets are starting points, not guarantees about a model's responses:

| Sampling preset | Temperature | Top-P | Top-K | Min-P |
| --- | --- | --- | --- | --- |
| Default | Native | Native | Native | Native |
| Focused | 0.6 | 0.95 | 20 | 0 |
| Exploratory | 1 | 0.95 | 20 | 0 |
| Min-P | 1 | 1 | 0 | 0.05 |

Here, **Native** means no explicit override is sent. Explicit presets use repeat
penalty 1 and presence/frequency penalties 0. Changing presets preserves seed,
output length, context, cache and performance settings.

Use **Fine-tune reply style** to adjust individual sampling controls. **Auto** or
an empty field uses the model’s default. These controls influence how the next
token is selected:

| Control | Effect | Accepted explicit values |
| --- | --- | --- |
| Temperature | Higher values allow more varied choices; lower values favor likely tokens. | Nonnegative decimal |
| Top-P | Keeps the most likely tokens whose combined probability reaches this share. | 0 to 1 |
| Top-K | Keeps at most this many likely tokens; `0` disables this filter. | Nonnegative integer |
| Min-P | Removes tokens unlikely relative to the most likely token. | 0 to 1 |
| Repeat penalty | Discourages recent repetition; `1` is neutral. | Positive decimal |
| Presence penalty | Positive values discourage tokens that have already appeared. | Signed decimal; `0` is neutral |
| Frequency penalty | Positive values penalize tokens more as they recur. | Signed decimal; `0` is neutral |

### Speed and performance in Model settings

**Auto** omits the corresponding launch override so llama.cpp can choose. Flash
Attention is automatic. Device names come from `llama-server --list-devices`;
available cache types and split modes come from its help.

| Control | Behavior |
| --- | --- |
| Device | **Auto** lets llama.cpp choose. **CPU only** uses `--device none --gpu-layers 0`. Explicit device names use the selected backend's advertised identifiers. |
| CPU threads | **Auto** or an explicit count. More threads are not always faster. |
| Model on the GPU | GPU layers: **Auto**, **All**, or a count. **CPU only** disables GPU layers regardless of this value. |
| Reading your message | Prompt processing preset; **Default** uses native batch settings. |

| Prompt processing | Batch size | Microbatch size |
| --- | --- | --- |
| Default | Native | Native |
| Low memory | 512 | 128 |
| Large batch | 2048 | 1024 |

Larger batches use more memory and do not guarantee better performance.

When multiple usable devices are available, **Advanced: several devices** exposes
ordered device names, supported split modes, relative device proportions and
fitting margins in MiB. For example, proportions `2,1` request twice the share on
the first device; these are relative weights, not memory sizes. Use nonnegative
proportions with at least one positive value. Margins accept nonnegative integer
MiB values. Values follow device order. Tensor mode is experimental;
margins are fitting targets, not allocation limits. CPU-only startup omits GPU
distribution settings.

Memory measurements are optional and approximate. **Unavailable** means a reading
is missing, not that capacity is zero. Missing measurements never block server
controls. Device support depends on the backend and drivers; a backend label does
not establish hardware identity or guarantee a model will fit.

#### Multi-token prediction (MTP)

Under **Model settings → Speed**, **Multi-token prediction (MTP)** offers:

| Choice | Behavior |
| --- | --- |
| **Off** (default) | Disables speculative decoding when the backend advertises `--spec-type`. Does not load an MTP file. |
| **Use model's MTP** | Enables `--spec-type draft-mtp` using MTP components included in the selected model. |
| **Use external MTP file…** | Opens the native file picker and enables MTP with the selected compatible GGUF, passed using the advertised `--spec-draft-model` or `--model-draft` option. Canceling preserves the previous selection. |

MTP can improve generation speed, but requires compatible model components and
can use additional memory. Backend support is detected from its advertised
`--spec-type` choices; it does not establish support in an individual model.
llama.cpp validates model compatibility and determines device placement and
other MTP defaults. No model-name or hardware heuristics are used. Unsupported
choices are disabled, and launch reports unsupported options or missing files
explicitly. The filename and expandable path remain visible while external MTP
is selected; **Change MTP file…** replaces it.

Native speculative type or draft-model overrides, including
`LLAMA_ARG_SPEC_TYPE` and `LLAMA_ARG_SPEC_DRAFT_MODEL` (and legacy draft-model
aliases), take precedence even when empty. The MTP control names these variables
and is disabled while they are present. Custom draft tuning variables continue
through to llama.cpp unchanged. The application does not download an MTP file
or template automatically.

### Server in Model settings

The default port is **9931**; valid ports range from 1 to 65535. Supervised servers
listen on `127.0.0.1`, so connections stay on this computer, and starting a server
does not open a browser.

To change the port, enter a value and select **Check again** to apply settings
and refresh listener details. If the server is running, restart it to use the new
port. Any occupied port blocks startup, even when its listener cannot be
identified. See [Resolve an occupied port](#resolve-an-occupied-port) before
stopping another program.

### Saved configurations

A saved configuration, also called a profile in the file format, stores the model,
its settings on this computer and your chat defaults. It does not contain folders or conversations.

To save a new configuration:

1. Review your edited settings.
2. In **Model settings**, open **Manage configurations…** and enter a **New configuration name**.
3. Select **Save as new configuration**. If the name already exists, review the
   overwrite confirmation before replacing it.

To reuse a configuration, choose its name from the configuration menu beside **Apply changes**. Confirm replacement when there are unapplied changes. This opens
**Model settings** for review without starting or applying a server. When loading
would change chat defaults, the confirmation says **Also replaces your chat defaults.**
After confirmation, those defaults save immediately; server fields remain in the
draft for **Apply changes**. Use **Save to selected**
to replace a selected configuration after confirmation. **Delete configuration**
also requires confirmation; current settings and conversations remain available.

Names start with an alphanumeric character and accept letters, digits, spaces,
dots, underscores and hyphens, up to 80 characters. Failed writes preserve the
previous file and saved association. See [Profile compatibility](#profile-compatibility)
for older files and missing-field defaults.

### Model files and folders

In **Model files**, the models folder precedes the optional Hugging Face token. **Create models folder** creates `models/` beneath Tauri’s app data
directory for bundle identifier `io.github.etufarini.straggler`. The UI shows the
resolved path before creation. This is separate from conversation storage. The
Linux path is `${XDG_DATA_HOME:-$HOME/.local/share}/io.github.etufarini.straggler/models`;
on macOS it is `~/Library/Application Support/io.github.etufarini.straggler/models`.
**Choose existing folder** uses the system
picker; cancellation preserves the current folder. Flatpak uses FileChooser over
D-Bus without an external helper fallback. A missing portal produces an error.

Discovery searches the selected folder and two nested directory levels. Existing
root-level GGUF files still work. Split models appear once, using the first part;
all numbered parts must be present. Empty folders are valid.

In **llama.cpp**, **Choose external build…** opens the existing folder
browser. Browse without saving, then accept with **Use this folder**. Hidden
folders can be shown or opened by path. A backend folder must contain executable
`build/bin/llama-server` or `bin/llama-server`; source builds take precedence.
Stop the server before changing its backend. See
[Select the backend in Straggler](#select-the-backend-in-straggler) for GPU setup
and returning to the included backend.

### Hugging Face

A token is optional. In **Settings → Model files**, save or remove a read token
in the operating system keychain: Secret Service on Linux, Keychain on macOS.
It is never saved in settings, browser storage or the download journal. If the
keychain is unavailable or locked, public access remains available and the UI
reports the problem. Flatpak must permit access to its system Secret Service.

Open **Models → Hugging Face** and explicitly search for GGUF repositories, paste
`publisher/repository`, or paste an HTTPS Hugging Face repository/file link. Open
a result, choose a file version and optionally an mmproj file documented by its
publisher. Downloading a projector does not enable image input in Straggler.
**Repository revision** allows a branch, tag or commit; downloads pin the resolved
commit. File-size memory estimates are approximate: context, cache and device
placement affect actual use. Unknown RAM does not block downloads.

Review the publisher’s model card and license. Gated repositories may require
license acceptance or approval in your browser plus an authorized read token.
Use **Copy repository link**, complete access there, then retry. Straggler does
not accept licenses or create an account on your behalf.

Files go to `models-folder/publisher/repository/file.gguf`. Space is checked before
transfer. **Pause** keeps `.gguf.part` and its identity sidecar; **Resume** uses
HTTP Range, or restarts safely if the server ignores Range. Restarting Straggler
restores paused downloads without contacting the Hub. Resume is explicit.
**Cancel** removes only matching partial files. Existing unrelated files remain.
SHA-256 must be reported by the Hub and match every part before final files are
published. Split models download and verify as a group, then appear under
**On this computer**. Closing the app pauses active transfers. Failed writes,
interrupted transfers and checksum failures are reported with retry controls.

Opening settings, switching tabs, startup and local model discovery do not
contact Hugging Face. Search, opening/retrying a repository, download and resume
are the network actions. No inference service is contacted by these controls.

### Web search

In **Settings → Web search**, add your API key and choose **Save and verify**.
The key stays in the operating system's keychain; replacing it requires successful
verification before the old key is changed. Removing a key does not remove saved sources.
The service, its signup link and its free plan are shown in Settings.

Turn on **Web search** in the composer before sending a message. It applies to that
message only, including in temporary chats. It starts off, returns off after sending,
and resets when opening or switching chats. Saving a key does not enable it. Only
the first-use acknowledgement and the search limit are saved in preferences.
Search queries and fallback page addresses go to the selected service. The chat
history and attachments remain local; a model-generated query can include details
from the context, so review what you share when enabling web access.

The default limit is three searches per message, adjustable from one to five.
Identical searches are cached in memory for 15 minutes. Straggler first reads public
web pages locally with a timeout and size limit; the service is used only if local
reading fails. Page extraction may incur additional service charges. Local/private
network addresses and non-HTTP(S) pages are excluded.

Supported backends start with `--jinja` when advertised. Straggler uses the loaded
template's advertised tool capabilities, never a model filename. If support is
unknown or absent, it runs one search with your submitted text and adds the results
to the current request. Template compatibility cannot guarantee that a model will
choose or use tools correctly. Search failures show a notice and the local answer
continues without web search.

Search activity, numbered citations and **Sources** appear in the response. Sources
for the latest response also appear in the right panel. Links open in the default
browser. Only numbers associated with an existing source become citation links.
Saved chats contain normalized sources and activity, never provider JSON or keys.
Monthly usage is refreshed in Settings and after searched responses, subject to
the service's rate limit. An unknown renewal date is displayed as unavailable.

### llama.cpp

This section identifies the selected backend and displays available version,
commit and build details. The bundled backend is pinned; its updates arrive with
application updates. Use **Choose external build** to
select an existing build or **Use bundled version** to return to the included one.
Stop the server before switching. The included backend shows its version, build
number and release date from packaged metadata, with no runtime release lookup.
External version/build/commit come from `llama-server --version`, including its
stderr output. Opening **Settings → llama.cpp** checks the public GitHub API for
the corresponding upstream release. Its publication date is shown only when the
release tag resolves to the commit reported by the binary, including abbreviated
commit hashes and annotated tags. Build-number tags are checked first; stable
semantic versions also check their version tag. This is the upstream release
date, not the date a local binary was compiled.

Release lookups run separately from configuration and server controls, with an
eight-second deadline. Results are cached in memory for five minutes for each
version/build/commit. The lookup sends only candidate upstream tags; no local
paths, models or conversations are sent. It never downloads or changes a backend.
Builds without a usable commit, missing releases and commit mismatches show why
the date cannot be verified. Network errors and API rate limits show a **Retry
lookup** action. Backend startup and chat remain available without this lookup.

External builds can advertise different devices and options. Straggler discovers
those capabilities rather than assuming that every build supports the same
settings. See [CPU and GPU support](#cpu-and-gpu-support) for the included backends
and external CUDA/Vulkan builds.

## Server controls and troubleshooting

### Start, stop and inspect the server

From chat, select **Launch server** or choose a model and select **Use model**.
Both start llama.cpp with the selected settings. **Ready** means the server is
available for requests. Open the status badge to read the server log; it retains
the latest 300 lines and can include local file paths, so review it before sharing.

**Stop response** cancels generation while preserving partial text. **Stop server**
shuts down the supervised backend. After changing launch settings, stop and launch
it again to clear **Restart required** and use the new configuration.

Closing the app asks you to confirm cancellation, saving and cleanup of its own
server. If saving fails, keep the window open and use the recovery controls below.

### Resolve an occupied port

1. Open **Settings → Model settings → Server** and inspect the available listener details.
2. Prefer another available port if the existing program needs to keep running.
   Enter the new port and select **Check again**.
3. If you intend to stop the unrelated program, select **Close programs using it**
   and review the confirmation. This requests normal shutdown with SIGTERM.
4. If it remains after that attempt, **Force quit…** requires a separate
   confirmation before sending SIGKILL.

Straggler rechecks process identity before signaling and never elevates
process-control permissions. A listener it cannot identify still blocks launch.

### Recover from storage errors

Saving errors appear beside the composer. Keep the window open, check free space
and write permissions for the [data directory](#storage-locations), then select
**Retry saving** to write the current conversation. New chats and conversation
switching wait while text is unsaved; Settings, logs and server controls remain
accessible.

If history could not be loaded, fix the storage problem and select **Retry
loading**. Failed response edits keep the editor open and preserve the previously
saved response. Preference errors are reported separately; the layout remains
usable for the current session.

### Recover from a backend failure

An explicit fatal backend failure sets **Needs restart**. Confirmed memory
exhaustion shows **Not enough memory**. To recover:

1. Read **Technical details** and the server log.
2. Stop the server.
3. Review context size, choose **Low memory** prompt processing, or select a
   smaller supported model as appropriate to the error.
4. Apply the settings and launch the server again.

Straggler does not change settings automatically. A healthy HTTP endpoint does
not clear a fatal failure; a new server run does. Generic compute errors are not
labelled memory exhaustion without supporting evidence, and recoverable allocation
warnings alone do not block chat.

### Other common problems

| Symptom | What to check |
| --- | --- |
| No GGUF models found | Select a readable models folder containing supported GGUF files, then refresh models. Subfolders are searched; an empty folder is valid but offers no model to load. |
| Backend unavailable | In source development, select an existing external build. For a package missing its included backend, reinstall the package or choose an external build. |
| Unsupported option or device | Read the server log and review explicit settings against the selected backend's advertised capabilities. Different builds may support different options. |
| Reasoning unavailable | Check the running template's advertised capabilities. Separate reasoning is shown only if the server returns it. |
| Context full | Exclude or remove files, or apply a larger supported context and restart. See [context limits](#shared-files-and-context-limits). Content is never dropped automatically to fit. |
| Native services unavailable | Open the native app. A plain browser preview cannot access the desktop services or run local chat. |
| Source build fails | Check Node/Rust versions, Tauri prerequisites, dependency downloads and free disk space. Follow [Local development](#local-development) for setup. |

## Data, backups and compatibility

### Storage locations

Settings and conversations use separate directories. The published desktop
packages use these paths on Linux and macOS:

| Data | Location |
| --- | --- |
| Saved folders | `${XDG_CONFIG_HOME:-$HOME/.config}/straggler/paths.conf` |
| Chat defaults | `${XDG_CONFIG_HOME:-$HOME/.config}/straggler/chat-defaults.conf` |
| Saved configurations | `${XDG_CONFIG_HOME:-$HOME/.config}/straggler/profiles/*.conf` |
| Hub download journal (no token; restores paused) | `${XDG_DATA_HOME:-$HOME/.local/share}/straggler/desktop/huggingface/downloads.json` |
| Conversations, attachments, projects, preferences and session lock | `${XDG_DATA_HOME:-$HOME/.local/share}/straggler/desktop/` |

The path notation means: use `XDG_CONFIG_HOME` or `XDG_DATA_HOME` when set to a
nonempty value; otherwise use `.config` or `.local/share` under your home folder.
Model files and external backends stay in the folders you selected. Desktop
storage is separate from browser conversations and preferences.

Conversation attachment originals live under `conversations/<UUID>/attachments/`.
Project records live under `projects/<UUID>/project.json`, with extracted text in
`files/<UUID>.txt`. Identifiers are validated, writes are atomic and saves are
serialized.

### Back up your data

Close Straggler after saving and letting it stop its server. Copy both the active
configuration directory and the desktop data directory to your backup location.
Copy each directory in full so conversations, projects and stored files remain
associated. Back up model files and external builds separately if needed.

Before restoring, close the app and retain a copy of the current directories.
Restore each directory to its corresponding location; there is no automatic merge
between backups and existing history. On another computer, review folder paths
and model selections before launching the server.

A conversation export is useful for moving message text and its effective prompt.
It omits attachments and project records, so it is not a complete data backup.
For older installations, identify the active directories using the rules below.

### Earlier Mir.cpp installations

Straggler was previously named Mir.cpp. For each configuration/data root, an
existing `mir.cpp/` directory is reused when `straggler/` is absent. Its data and
session lock stay in place. If both directories exist, `straggler/` takes
precedence; nothing is copied, merged or deleted. Apply this rule independently
to configuration and data when locating a backup.

External backend metadata accepts `straggler-build.conf` or the legacy
`mir-build.conf`; the new filename takes precedence. Old `llama-launcher` settings
migrate atomically only when Straggler configuration is absent, with originals
preserved. Previous shell installations are not upgraded automatically, and the
old v1.0.0 terminal installer does not install the desktop app. Back up shared
settings and data before removing an old installation.

### Conversation export format

Exports are UTF-8 `mir.cpp/conversation` version 1 JSON, with optional reasoning.
The name is retained for compatibility with earlier exports. Import also accepts
a plain array of `{role, content}` messages and recognizes `reasoning` as an alias
for `reasoning_content`. Invalid imports leave stored history unchanged.

### Profile compatibility

Profiles are literal `key=value` data and are never executed. Only the model field
is required on load. Missing fields use independent defaults rather than values
from the current session: port 9931, `q4_0` caches, an empty system prompt, no
custom template, MTP Off with no external file, and Auto for other controls. Auto
sampling corresponds to the Default preset.

Unknown or removed keys are ignored. Invalid recognized fields, duplicate
recognized keys or malformed lines reject the entire load, leaving the current
settings available.
Loading does not rewrite older profiles. Saving writes current fields; prompts
are JSON-encoded on one line to preserve multiline Unicode text as data.
When changing profile fields, keep saved-configuration comparisons consistent
with profile serialization so **Modified** reflects the values that will be saved.

### Environment controls

Environment values initialize a session. An explicitly set `STRAGGLER_*` value
wins over the corresponding `MIR_*` value, then the legacy fallback below.
Explicit empty values at either application prefix still take precedence; invalid
values are reported rather than replaced. The supervised server stays on loopback.

| Control | Legacy fallback / default |
| --- | --- |
| `STRAGGLER_LLAMA_CPP_DIR` | `LLAMA_CPP_DIR` / saved external path or bundled backend |
| `STRAGGLER_MODELS_DIR` | `LLAMA_MODELS_DIR` / saved path |
| `STRAGGLER_CHAT_TEMPLATE_FILE` | `LLAMA_CHAT_TEMPLATE_FILE` / empty (model template) |
| `STRAGGLER_MTP` | `LLAMA_MTP` / off (`off`, `model` or `file`) |
| `STRAGGLER_MTP_FILE` | `LLAMA_MTP_FILE` / empty |
| `STRAGGLER_CTX_SIZE` | `LLAMA_CTX_SIZE` / auto |
| `STRAGGLER_PORT` | `LLAMA_PORT` / 9931 |
| `STRAGGLER_DEVICE`, `STRAGGLER_THREADS`, `STRAGGLER_GPU_LAYERS` | Corresponding `LLAMA_*` / auto |
| `STRAGGLER_PROMPT_PROCESSING` | `LLAMA_PROMPT_PROCESSING` / auto |
| `STRAGGLER_GENERATION_PRESET` | `LLAMA_GENERATION_PRESET` / default |
| `STRAGGLER_CACHE_TYPE_K`, `STRAGGLER_CACHE_TYPE_V` | Corresponding `LLAMA_ARG_*` / q4_0 |
| `STRAGGLER_SPLIT_MODE`, `STRAGGLER_TENSOR_SPLIT`, `STRAGGLER_FIT_TARGET` | Explicit values, otherwise native `LLAMA_ARG_*` behavior |

Individual sampling controls use `STRAGGLER_TEMPERATURE`, `STRAGGLER_TOP_P`,
`STRAGGLER_TOP_K`, `STRAGGLER_MIN_P`, `STRAGGLER_REPEAT_PENALTY`,
`STRAGGLER_PRESENCE_PENALTY`, `STRAGGLER_FREQUENCY_PENALTY`, `STRAGGLER_SEED` and
`STRAGGLER_MAX_TOKENS`, with corresponding legacy `LLAMA_*` aliases.

Native `LLAMA_ARG_*` variables pass through unchanged. Template and MTP native
overrides disable their GUI controls as described above; other explicit GUI
launch arguments take precedence according to llama.cpp's parser. Requests can
override server sampling defaults without changing another client's stored preferences.
Explicit STRAGGLER_*, MIR_* and legacy LLAMA_* generation controls retain their
precedence at startup over the durable chat defaults, including explicit empty values.

## Development and architecture

Straggler is written for human maintainers. Keep changes readable and validate
configuration, user flows, persistence and process lifecycle without GPU hardware,
model weights or a working llama.cpp installation. Real inference and hardware
diagnostics are optional integration work.

### Local development

For the native app, install Node.js 22.13+, 24 or 26+, Rust 1.92+ with rustfmt and
Clippy, and the platform's [Tauri development prerequisites](https://v2.tauri.app/start/prerequisites/).
Python 3.9+ is needed for test fixtures and packaging. Dependencies are installed
explicitly using existing platform tools; there is no private toolchain bootstrap.

From the repository root:

```bash
npm --prefix straggler/desktop ci
npm --prefix straggler/desktop run desktop
```

The second command starts Vite and opens the native Tauri window. Use it again
after setup. To chat with a model during development, select an existing external
llama.cpp build under **Settings → llama.cpp**.

For browser-only UI work, run `npm --prefix straggler/desktop run dev` and open
`http://127.0.0.1:1420/?scenario=empty`. Named scenarios provide clearly labelled
simulated services and responses. A plain browser preview reports that native
services are unavailable; production assets exclude the fixture service. The
[desktop README](../desktop/README.md#browser-fixtures) lists available scenarios.

### Development disk usage

Native development and tests use limited debug information without incremental
compilation, retaining source locations in backtraces. Debugger type/variable
inspection is reduced, and recompilation can take longer. Release builds keep
their existing profile. See the
[Cargo profile reference](https://doc.rust-lang.org/cargo/reference/profiles.html).

After finishing native validation and closing development sessions, run from
the repository root:

```bash
npm --prefix straggler/desktop run clean
```

This deletes generated Rust artifacts under `straggler/desktop/src-tauri/target`,
including binaries and any packages built there. It preserves application data,
models, dependencies, test evidence and `packaging/generated`. The next native
build recompiles dependencies. See the [artifact boundaries](../desktop/README.md#build-artifacts)
for the command reference. External `CARGO_TARGET_DIR` overrides are ignored.
Packaging build directories are separate; inspect them and preserve candidates
still under review before any manual cleanup. Cleanup is explicit, not run
between CI checks that reuse compilation results.

### Run the checks

Use the repository's test runner as the development entry point. Install browser
engines once before running browser checks:

```bash
cd straggler/desktop
npm exec -- playwright install webkit
cd ../..
bash straggler/tests/run.sh
```

On Linux, browser checks may also need Playwright system dependencies installed
explicitly during development setup. The runner does not install system packages.
The default suite checks common runner boundaries, frontend, runtime, browser and
native-window behavior. Offline archive checks are included in common checks;
`packaging` adds focused native resource/backend and macOS sandbox boundary checks.

For focused work, append a suite name, for example:

```bash
bash straggler/tests/run.sh frontend
bash straggler/tests/run.sh runtime
bash straggler/tests/run.sh browser
bash straggler/tests/run.sh packaging
```

See the [suite table](../desktop/README.md#test-suites) for all choices and their
prerequisites. Frontend and browser checks need no Rust or native GUI libraries.
Runtime checks need Rust, Python fixture support and the host linker, but no npm
or native GUI libraries. Isolation and native-window checks need the host's Tauri
development dependencies.

Tests use temporary user directories, fake executables, generated documents and
local HTTP/SSE fixtures. They do not need personal configuration, a GPU, model
weights or an inference service. The runner works with macOS system Bash 3.2;
ShellCheck is optional locally and installed in CI.

On headless Linux, native checks use Xvfb, a private D-Bus session and software
rendering when available. An explicitly requested `native` suite fails without
a display or those tools; the default suite reports the native check as skipped.

CI runs on pull requests and pushes to main, avoiding duplicate branch-push runs.
The required workflow has three jobs:

- Linux frontend: common checks, formatting/lint/types/build, domain tests and
  shared browser interactions using WebKit.
- Linux desktop: Rust runtime contracts and the actual native window, resources,
  IPC, storage and supervised-process lifecycle.
- macOS desktop: the equivalent native checks and a small `browser-platform`
  subset covering host-sensitive keyboard, IME and focus regressions.

Shared browser behavior is checked once. Rust build dependencies are cached by
platform and toolchain. Representative layouts replace exhaustive combinations;
accessibility, contrast, reduced motion and known behavioral regressions remain
covered. Decorative styling is reviewed with the explicit screenshot tools in the
[desktop README](../desktop/README.md#optional-visual-diagnostics).
Aim for roughly ten minutes of required execution with warm caches, measuring
runner queues separately; the target does not permit skipping failures. Browser
failures retain screenshots, traces and a JSON report, with no automatic retries.
Keep workflow history under normal GitHub retention so failures remain available
for diagnosis. Packaging and performance diagnostics remain explicit checks,
required when the change affects those boundaries.

The runtime suite runs Rust tests serially to isolate native socket probes and
process fixtures; tests of concurrent operations still run their own workers.
The isolation check compiles the actual desktop
without the opposite platform's module/configuration. Linux browser WebKit does
not replace native macOS WebView and process checks. Native WebDriver is debug-only
and rejected in release builds. Pinned upstream fixture contracts are listed in
the [desktop README](../desktop/README.md#upstream-fixture-contracts).

### Architecture

The visible repository root is limited to `README.md`, `AGENTS.md`, `LICENSE`
and `straggler/`. Desktop code lives in `straggler/desktop/`, the development test
runner in `straggler/tests/run.sh`, and documentation in `straggler/docs/`.
Hidden repository and development configuration remains at the root where needed.

```text
React features → typed desktop service → Tauri commands → Rust configuration and storage
                                                       → native OS services
                                                       → supervised llama-server and HTTP/SSE
```

Rust owns configuration, profile compatibility, GGUF metadata discovery, ports,
process identity, shutdown, chat streaming, history and project storage. Linux
uses procfs/pidfd; macOS uses libproc. The app does not invoke shell/Python helpers
or system inspection commands. Bundled resources are resolved relative to the
native executable or resource directory, independently of the working directory.
Keep Linux builds independent of macOS files and Homebrew.

Frontend modules separate app composition, features, shared controls and domain
logic. All Tauri IPC passes through `src/services/desktop.ts`. Native defaults in
`src-tauri/src/configuration/defaults.json` are also imported by development fixtures.
Assistant presence instantiates `OrbRenderer` directly. The adapter owns reduced-motion,
visibility and cleanup handling through the renderer contract; animation is
presentation rather than inference telemetry.

| Responsibility | Owning modules and flow |
| --- | --- |
| UI and edited state | `src/app/useWorkspace.ts` composes feature hooks; `src/domain/` owns pure rules. Edited settings, saved settings and active server settings remain separate. |
| Native interface | `src/services/desktop.ts` owns IPC commands, channels, dialogs and development fixture dispatch; `src-tauri/src/main.rs` registers commands and delegates to the runtime. Fixture modules are excluded from production transport. |
| Configuration and server | Rust `configuration/` validates and serializes profiles, environment controls and backend capabilities; `workspace.rs` coordinates settings; `server.rs` supervises loopback processes through `platform/`. |
| Requests and persistence | `chat.rs`, `stream.rs` and `tokens.rs` handle requests, cancellation and SSE. `history.rs`, `projects.rs`, `temporary.rs` and frontend storage queues preserve save ordering, recovery and partial responses. |
| Optional remote services | Rust `cloud/`, `web_search/` and `huggingface/` own provider requests. `credentials.rs` owns native keychain access and shared password operations; each service retains its account names, validation and error messages. |
| Development and distribution | `straggler/tests/run.sh` selects checks; `tests/` and `src-tauri/tests/` supply isolated fixtures. `packaging/` prepares the pinned backend and native packages; these utilities are not application runtime dependencies. |

React and TipTap/ProseMirror own rendering and editing; the Markdown/math/highlighting
packages own message presentation. Tauri supplies the native bridge. Rust delegates
HTTP to reqwest, asynchronous work to Tokio, search indexing to Tantivy, document
and image extraction to format libraries, and credentials to platform keychain stores.
These dependencies have active callers; optional features, dynamic CSS classes,
legacy readers and explicit diagnostics must not be removed solely because they
are absent from a static application import graph.

## Packaging and releases

### Published downloads

[Straggler 1.0.0](https://github.com/etufarini/Straggler/releases/tag/straggler-v1.0.0)
was published on November 22, 2026, with these desktop packages:

| Platform | Download |
| --- | --- |
| macOS 13.5+ Apple Silicon (ARM64) | [Straggler-1.0.0-macos-arm64.dmg](https://github.com/etufarini/Straggler/releases/download/straggler-v1.0.0/Straggler-1.0.0-macos-arm64.dmg) |
| Ubuntu 24.04+ x86-64 (amd64) | [straggler_1.0.0_amd64.deb](https://github.com/etufarini/Straggler/releases/download/straggler-v1.0.0/straggler_1.0.0_amd64.deb) |

Download [SHA256SUMS](https://github.com/etufarini/Straggler/releases/download/straggler-v1.0.0/SHA256SUMS)
and compare the digest for your package before installing. On macOS:

```bash
shasum -a 256 Straggler-1.0.0-macos-arm64.dmg
```

Open the disk image, drag Straggler to Applications and launch it there. Close
an existing installation before replacing it. The 1.0.0 download is ad hoc signed;
it is not Developer ID signed or notarized. Gatekeeper may block opening it.
Ad hoc signing checks bundle integrity but does not identify a Developer ID
publisher. Users who require a notarized publisher identity should wait for a
signed distribution.

On Ubuntu 24.04+ x86-64:

```bash
sha256sum straggler_1.0.0_amd64.deb
sudo apt install ./straggler_1.0.0_amd64.deb
```

Using `apt` installs the declared system dependencies. Open Straggler from the
application menu. Installed startup does not compile code or install tools.
Models and any external GPU-enabled backend remain separate.

There are no macOS Intel or Linux ARM64 desktop packages in the 1.0.0 release.
The build targets below do not establish published download availability. GitHub's
source archives and Actions artifacts are not published desktop installers.

### Building packages

Run the commands below from `straggler/desktop`, after `npm ci` and the host
platform setup. Build on the matching target operating system and architecture.
Plain `npm run bundle` builds the Tauri app without preparing the pinned backend;
use the packaging tools to produce a package containing that backend.

`packaging/llama-runtime.json` pins backend release `b12248`, its source commit and
per-architecture SHA-256 digests, version, build number and release date.
The release date is the GitHub `published_at` of the pinned `bNNNN` release,
recorded during packaging rather than fetched by the installed app. To refresh
metadata while deliberately updating a pin, run
`python3 packaging/backend.py --refresh-release-metadata --version VERSION`
from the desktop directory and review the changed JSON. Preparation verifies
archives, copies only required executables/libraries, and includes both licenses
and provenance. It rejects unsafe archive paths and unknown external dependencies.
A failed preparation preserves the previous result. `prepare` and `bundle` accept
`--archive /path/to/archive.tar.gz` for an existing official archive, still verified
against the pinned digest. Without `--archive`, preparation downloads the pinned
upstream archive. Model weights are never bundled or downloaded by these commands.

#### macOS

Build on the matching Mac architecture with Xcode command line tools:

```bash
python3 packaging/macos.py bundle --target aarch64-apple-darwin
```

The packager also accepts `x86_64-apple-darwin` on Intel. The default creates the
GUI and a DMG with an Applications shortcut. Output is under
`packaging/generated/build/<target>/release/bundle/macos/`. Libraries, helper and
app are signed and checked; the DMG copies the signed app without rebuilding it.
The default ad hoc signature is suitable for local checks and is the signature
used by the published 1.0.0 package. For Developer ID distribution, use
`--signing-identity "Developer ID Application: YOUR IDENTITY"`, then notarize and
staple the candidate using Apple's tooling before publishing. The packager does
not notarize, upload or publish. See
[Tauri signing guidance](https://v2.tauri.app/distribute/sign/macos/).

`prepare` verifies and stages the backend without compiling. To stage only the
backend, replace `bundle` with `prepare` in the platform's command. With `bundle`,
`--probe` builds a separate sandbox diagnostic under `generated/build-probe/`,
with no chat window. It checks backend version/help and writes an isolated report.
Its `--select-model` runtime option performs an optional CPU loading check through
the native picker; no model is downloaded. Loading diagnostics are separate from
normal development and do not establish inference performance. Sandboxed variants
are development diagnostics, separate from the published desktop packages.

#### Ubuntu

Build on Ubuntu 24.04+ with the matching architecture, Tauri prerequisites,
`patchelf` and `dpkg-deb`:

```bash
python3 packaging/ubuntu.py bundle --target x86_64-unknown-linux-gnu
```

The packager also accepts `aarch64-unknown-linux-gnu` on ARM64. Packages are under
`packaging/generated/build-ubuntu/<target>/release/bundle/deb/`. Install with
`sudo apt install ./<package>.deb` and open Straggler from the application menu.
The native executable is `/usr/bin/straggler-desktop`; private backend files live
under `/usr/lib/straggler/backend/`, and licenses/provenance under
`/usr/share/doc/straggler/`. There is no public launcher command or direct-model CLI.

The packager patches backend library lookup to `$ORIGIN`, extracts the actual
DEB into temporary storage, compares its backend/resources, verifies dynamic
loaders and checks the GUI's embedded assets and backend version/help. No model
is loaded. Runtime dependencies include glibc 2.39+, WebKitGTK 4.1, GTK 3,
libstdc++, OpenMP and OpenSSL 3; older distributions are not claimed compatible.

### Release candidates and approval

The optional packaging workflow builds macOS GUI and sandbox diagnostics, plus
Ubuntu DEBs, on native ARM64/x64 runners. It retains packages and test evidence as
Actions artifacts. Trigger it from a branch with:

```bash
gh workflow run backend-packaging.yml --ref YOUR_BRANCH
```

Normal push checks do not download the backend. Candidate artifacts are for
review; building one or merging `main` does not publish a release. Before release,
verify installation and replacement, native dialogs, permissions, dependency
notices and signing/notarization on each supported platform. No GPU workload or
hardware inventory is a release gate.

Use semantic versions. The exact version, full candidate SHA and release notes
require explicit approval before tagging or publishing. Record the source commit,
successful check and packaging runs, backend pin, published targets, signing status
and unverified boundaries in the release notes. Keep `SHA256SUMS` beside the
versioned packages. Never replace a published binary with different bytes under
the same filename, move a published tag or delete a remote branch without approval.
Keep successful and failed check runs under normal GitHub retention.

### Release history and compatibility

Straggler desktop 1.0.0 uses tag `straggler-v1.0.0`, at source commit
`58329a1f0ce35d388c76e8a87208ba481f27fe4f`. The historical Mir.cpp `v1.0.0` tag
remains at its original commit. Existing settings and conversation compatibility
are described under [Earlier Mir.cpp installations](#earlier-mircpp-installations).

### System prompt presets

In Settings › System prompts, save reusable instructions with a unique name and an optional description. Changes are saved automatically in `system-prompts.json` beside the desktop chat storage. An unreadable preset file is preserved and reported; reload after resolving the storage error.

Choose a preset under This chat in the system prompt menu, or use Insert preset in Chat defaults and project instructions. Selection copies the text; editing or deleting the preset never changes existing chats or projects. Save as preset saves the text currently shown in the chat prompt editor.

Export one preset or all presets as version 1 `straggler.system-prompts` JSON. Import supports that format, UTF-8 `.md` and `.txt` files, and LM Studio JSON containing an explicit `llm.prediction.systemPrompt` entry in `operation.fields`. Review the readable preview and choose Keep both or Replace for each conflicting name. Import never changes chat settings or sampling parameters.

### Formulas and code

Chat messages support inline LaTeX with `\(…\)` and display formulas with `$$…$$` or `\[…\]`. Single dollar signs stay plain text, so prices are unchanged. Display formulas align left and scroll horizontally when needed. Copy LaTeX copies their source. Invalid formulas show their source and an explanation; unfinished formulas remain muted source while the response streams. Formulas inside inline code or fenced code blocks stay literal.

Code blocks show their declared language and a Copy action. Blocks longer than about 24 lines offer Show more and Show less. Highlighting supports JavaScript, TypeScript, Python, Rust, Bash, JSON, CSS, HTML/XML and SQL; other languages remain readable plain code. Formulas, fonts and highlighting work offline. Editing responses and exporting chats preserve the original Markdown.

### Searching chat attachments

Small text attachments stay in the context in full. If instructions, included project files and chat attachments exceed the file allowance (75% of a known context window), Straggler switches to Search mode. Instructions remain whole. Each message searches the files using your message as the query and includes the highest-ranked passages that fit. Projects and chat attachments share the remaining space equally when both have files. Actual request token counts can reduce the selected passages further; messages or instructions that still exceed the context produce an explicit error.

The Attachments panel marks text files In context or Searched. Responses show Searched attachments and cite passages as `[A1]`, `[A2]`, and so on. Open a source to read the saved passage and, while the file remains attached, its full text. Project citations remain `[P1]`, `[P2]`, and so on. Retrieved excerpts are appended to the current outgoing user message only; your saved messages stay unchanged.

Attachment indexes live only in memory, including for ordinary chats, and temporary-chat cleanup erases their cache. There are no attachment index files to migrate or remove. Sidebar chat search also checks extracted attachment text. Images keep their existing vision-capability rules and are not searched as text. Chat export remains version 1 with the original messages.
