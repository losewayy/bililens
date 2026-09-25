# Privacy Policy for BiliLens

Last updated: September 18, 2026

BiliLens ("we", "our", or "the extension") is an open-source browser extension developed to provide AI-assisted reading notes and interactive chat for Bilibili videos. We are committed to protecting your privacy and ensuring you have complete control over your data.

## 1. Zero Personal Data Collection

BiliLens **does not collect, track, log, or sell** any personal identification information (PII), browsing histories, or usage analytics.
- We do not run any tracking pixels, telemetry scripts, or third-party analytics services.
- We do not operate any centralized tracking or proxy servers.

## 2. Local Storage of Credentials & Content

All sensitive information and generated data remain strictly on your local machine:
- **API Keys & Configurations**: Any AI model provider configurations (such as API keys, custom endpoint URLs, selected model names) are stored locally in Chrome's sandboxed local storage (`chrome.storage.local`).
- **Notes & Chat History**: Video summary notes, extracted transcripts, and chat conversations are cached locally in your browser storage. You can delete or clear this cache at any time from the extension's settings page.

## 3. Network Communications

The extension communicates only with services you explicitly interact with:
- **Bilibili Services (`bilibili.com`, `hdslb.com`)**: When browsing a Bilibili video, the extension retrieves public video details, subtitles, and official summaries directly from Bilibili's official endpoints and CDNs to present them in your side panel. No account cookies are collected or exfiltrated.
- **AI Model Providers**: When you request a summary note or send a question in chat, the video transcript snippet and your question are transmitted directly from your browser to the AI service provider endpoint you specified (e.g., DeepSeek, OpenAI, Claude, Moonshot, SiliconFlow, or a local Ollama server). Please refer to the privacy policy of the respective AI service provider you choose to configure.
- **Local Speech-to-Text (ASR)**: If you choose to enable the optional local speech recognition fallback, all audio processing is performed entirely on your own computer (`http://localhost` / `http://127.0.0.1`) without transmitting audio data outside your machine.

## 4. Permissions Usage

- **`storage`**: Used solely to persist your user preferences, model credentials, and local reading notes.
- **`sidePanel`**: Used to provide a non-intrusive side-by-side viewing and reading interface.
- **`downloads`**: Used only when you click the export button to save your notes as Markdown or subtitles as JSON to your computer.
- **`tabs`**: Used only to detect whether the active tab is a Bilibili video page so the extension can synchronize the appropriate video metadata.
- **`scripting`**: Injects a lightweight bridge script into Bilibili video pages to control playback timestamp seeking when you click timestamps in your notes.

## 5. Third-Party Sharing

We do not sell, rent, or trade your data to any third party for marketing, advertising, or credit assessment purposes.

## 6. Open Source & Transparency

BiliLens is open source. You can inspect the source code and review how network calls and storage are implemented at:
https://github.com/losewayy/bililens

## 7. Contact & Inquiries

If you have questions about this Privacy Policy or wish to report an issue, please submit an issue at:
https://github.com/losewayy/bililens/issues
