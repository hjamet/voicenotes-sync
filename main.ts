import { App, DataAdapter, Editor, moment, normalizePath, Notice, Plugin, PluginManifest, TFile } from 'obsidian';
import VoiceNotesApi from './voicenotes-api';
import { getFilenameFromUrl, isToday, formatDuration, formatTags } from './utils';
import { VoiceNotesPluginSettings } from './types';
import { sanitize } from 'sanitize-filename-ts';
import { VoiceNotesSettingTab } from './settings';
// @ts-ignore (Jinja types are not available)
import * as jinja from 'jinja-js';


const DEFAULT_SETTINGS: VoiceNotesPluginSettings = {
    automaticSync: true,
    syncTimeout: 60,
    downloadAudio: false,
    syncDirectory: 'voicenotes',
    deleteSynced: false,
    reallyDeleteSynced: false,
    todoTag: '',
    prependDateFormat: 'YYYY-MM-DD',
    noteTemplate: `
# {{ title }}

Date: {{ date }}

{% if summary %}
## Summary

{{ summary }}
{% endif %}

{% if points %}
## Main points

{{ points }}
{% endif %}

{% if attachments %}
## Attachments

{{ attachments }}
{% endif %}

## Transcript

{{ transcript }}

{% if audio_link %}
[Audio]({{ audio_link }})
{% endif %}

{% if todo %}
## Todos

{{ todo }}
{% endif %}

{% if email %}
## Email

{{ email }}
{% endif %}

{% if custom %}
## Others

{{ custom }}
{% endif %}

{% if tags %}
## Tags

{{ tags }}
{% endif %}

{% if related_notes %}
# Related Notes

{{ related_notes }}
{% endif %}

{% if subnotes %}
## Subnotes

{{ subnotes }}
{% endif %}
`,

    filenameTemplate: `
{{date}} {{title}}
`,
    debugMode: false,
    syncInterval: 30,
    excludeFolders: [],
    dateFormat: 'YYYY-MM-DD',
    prependDate: false
};

export default class VoiceNotesPlugin extends Plugin {
    settings: VoiceNotesPluginSettings;
    vnApi: VoiceNotesApi;
    fs: DataAdapter;
    syncInterval: number;
    timeSinceSync: number = 0;

    syncedRecordingIds: number[];

    ONE_SECOND = 1000;

    constructor(app: App, manifest: PluginManifest) {
        super(app, manifest);
        this.fs = app.vault.adapter;
    }

    async onload() {
        window.clearInterval(this.syncInterval);

        await this.loadSettings();
        this.addSettingTab(new VoiceNotesSettingTab(this.app, this));

        this.addCommand({
            id: 'manual-sync-voicenotes',
            name: 'Manual Sync Voicenotes',
            callback: async () => await this.sync(false),
        });

        this.addCommand({
            id: 'insert-voicenotes-from-today',
            name: "Insert Today's Voicenotes",
            editorCallback: async (editor: Editor) => {
                if (!this.settings.token) {
                    new Notice('No access available, please login in plugin settings');
                    return;
                }

                const todaysRecordings = await this.getTodaysSyncedRecordings();

                if (todaysRecordings.length === 0) {
                    new Notice('No recordings from today found');
                    return;
                }

                const listOfToday = todaysRecordings.map((filename) => `- [[${filename}]]`).join('\n');
                editor.replaceSelection(listOfToday);
            },
        });

        this.registerEvent(
            this.app.metadataCache.on('deleted', (deletedFile, prevCache) => {
                if (prevCache.frontmatter?.recording_id) {
                    this.syncedRecordingIds.remove(prevCache.frontmatter?.recording_id);
                }
            })
        );

        this.syncedRecordingIds = await this.getSyncedRecordingIds();
        await this.sync(this.syncedRecordingIds.length === 0);
    }

    onunload() {
        this.syncedRecordingIds = [];
        window.clearInterval(this.syncInterval);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async getRecordingIdFromFile(file: TFile): Promise<number | undefined> {
        return this.app.metadataCache.getFileCache(file)?.frontmatter?.['recording_id'];
    }

    async isRecordingFromToday(file: TFile): Promise<boolean> {
        return isToday(await this.app.metadataCache.getFileCache(file)?.frontmatter?.['created_at']);
    }

    sanitizedTitle(title: string, created_at: string): string {
        const date = moment(created_at).format(this.settings.dateFormat);
        const generatedTitle = this.settings.filenameTemplate
            .replace('{{date}}', date)
            .replace('{{title}}', title);
        return sanitize(generatedTitle);
    }

    /**
     * Return the recording IDs that we've already synced
     */
    async getSyncedRecordingIds(): Promise<number[]> {
        const { vault } = this.app;

        const markdownFiles = vault.getMarkdownFiles().filter((file) => file.path.startsWith(this.settings.syncDirectory));

        return (await Promise.all(markdownFiles.map(async (file) => this.getRecordingIdFromFile(file)))).filter(
            (recordingId) => recordingId !== undefined
        ) as number[];
    }

    async getTodaysSyncedRecordings(): Promise<string[]> {
        const { vault } = this.app;

        const markdownFiles = vault.getMarkdownFiles().filter((file) => file.path.startsWith(this.settings.syncDirectory));

        return (
            await Promise.all(
                markdownFiles.map(async (file) => ((await this.isRecordingFromToday(file)) ? file.basename : undefined))
            )
        ).filter((filename) => filename !== undefined) as string[];
    }

    async processNote(recording: any, voiceNotesDir: string, isSubnote: boolean = false): Promise<void> {
        if (!recording.title) {
            new Notice(`Unable to grab voice recording with id: ${recording.id}`);
            return;
        }

        if (this.syncedRecordingIds.includes(recording.recording_id)) {
            return;
        }

        const title = this.sanitizedTitle(recording.title, recording.created_at);
        const recordingPath = normalizePath(`${voiceNotesDir}/${title}.md`);

        // Prepare data for the template
        const creationTypes = ['summary', 'points', 'tidy_transcript', 'todo', 'tweet', 'blog', 'email', 'custom'];
        const creations = Object.fromEntries(
            creationTypes.map(type => [type, recording.creations.find((creation: { type: string }) => creation.type === type)])
        );

        const { transcript } = recording;

        // Destructure creations object to get individual variables if needed
        const { summary, points, tidyTranscript, todo, tweet, blog, email, custom } = creations;

        let audioLink = '';
        if (this.settings.downloadAudio) {
            const audioPath = normalizePath(`${voiceNotesDir}/audio`);
            if (!await this.app.vault.adapter.exists(audioPath)) {
                await this.app.vault.createFolder(audioPath);
            }
            const outputLocationPath = normalizePath(`${audioPath}/${recording.recording_id}.mp3`);
            if (!await this.app.vault.adapter.exists(outputLocationPath)) {
                const signedUrl = await this.vnApi.getSignedUrl(recording.recording_id);
                await this.vnApi.downloadFile(this.fs, signedUrl.url, outputLocationPath);
            }
            audioLink = `![[${recording.recording_id}.mp3]]`;
        }

        // Handle attachments
        let attachments = '';
        if (recording.attachments && recording.attachments.length > 0) {
            const attachmentsPath = normalizePath(`${voiceNotesDir}/attachments`);
            if (!await this.app.vault.adapter.exists(attachmentsPath)) {
                await this.app.vault.createFolder(attachmentsPath);
            }
            attachments = (await Promise.all(recording.attachments.map(async (data: any) => {
                if (data.type === 1) {
                    return `- ${data.description}`;
                } else if (data.type === 2) {
                    const filename = getFilenameFromUrl(data.url);
                    const attachmentPath = normalizePath(`${attachmentsPath}/${filename}`);
                    await this.vnApi.downloadFile(this.fs, data.url, attachmentPath);
                    return `- ![[${filename}]]`;
                }
            }))).join('\n');
        }

        // Prepare context for Jinja template
        const formattedPoints = points ? points.content.data.map((data: string) => `- ${data}`).join('\n') : null;
        const formattedTodos = todo ? todo.content.data.map((data: string) => `- [ ] ${data}${this.settings.todoTag ? ' #' + this.settings.todoTag : ''}`).join('\n') : null;
        const formattedTags = recording.tags && recording.tags.length > 0 ? recording.tags.map((tag: { name: string }) => `#${tag.name}`).join(' ') : null;

        const context = {
            title: title,
            date: moment(recording.created_at).format(this.settings.dateFormat),
            transcript: transcript,
            audio_link: audioLink,
            summary: summary ? summary.content.data : null,
            tidy: tidyTranscript ? tidyTranscript.content.data : null,
            points: formattedPoints,
            todo: formattedTodos,
            tweet: tweet ? tweet.content.data : null,
            blog: blog ? blog.content.data : null,
            email: email ? email.content.data : null,
            custom: custom ? custom.content.data : null,
            tags: formattedTags,
            related_notes: recording.related_notes && recording.related_notes.length > 0
                ? recording.related_notes.map((relatedNote: { title: string; created_at: string }) =>
                    `- [[${this.sanitizedTitle(relatedNote.title, relatedNote.created_at)}]]`
                ).join('\n')
                : null,
            subnotes: recording.subnotes && recording.subnotes.length > 0
                ? recording.subnotes.map((subnote: { title: string; created_at: string }) =>
                    `- [[${this.sanitizedTitle(subnote.title, subnote.created_at)}]]`
                ).join('\n')
                : null,
            attachments: attachments,
        };

        // Render the template using Jinja
        let note = jinja.render(this.settings.noteTemplate, context);

        // Add metadata
        const metadata = `---
    recording_id: ${recording.recording_id}
    duration: ${formatDuration(recording.duration)}
    created_at: ${recording.created_at}
    updated_at: ${recording.updated_at}
    ${formatTags(recording)}
---\n`;

        note = metadata + note;

        // Handle related notes and subnotes
        if (!isSubnote) {
            if (recording.subnotes && recording.subnotes.length > 0) {
                for (const subnote of recording.subnotes) {
                    await this.processNote(subnote, voiceNotesDir, true);
                }
            }
        }

        // Create or update the note file
        if (await this.app.vault.adapter.exists(recordingPath)) {
            await this.app.vault.modify(this.app.vault.getFileByPath(recordingPath) as TFile, note);
        } else {
            await this.app.vault.create(recordingPath, note);
        }

        this.syncedRecordingIds.push(recording.recording_id);

        if (this.settings.deleteSynced && this.settings.reallyDeleteSynced) {
            await this.vnApi.deleteRecording(recording.recording_id);
        }
    }

    async sync(fullSync: boolean = false) {
        console.debug(`Sync running full? ${fullSync}`);

        this.syncedRecordingIds = await this.getSyncedRecordingIds();

        this.vnApi = new VoiceNotesApi({});
        this.vnApi.token = this.settings.token;

        const voiceNotesDir = normalizePath(this.settings.syncDirectory);
        if (!(await this.app.vault.adapter.exists(voiceNotesDir))) {
            new Notice('Creating sync directory for Voice Notes Sync plugin');
            await this.app.vault.createFolder(voiceNotesDir);
        }

        const recordings = await this.vnApi.getRecordings();

        if (fullSync && recordings.links.next) {
            let nextPage = recordings.links.next;

            do {
                console.debug(`Performing a full sync ${nextPage}`);

                const moreRecordings = await this.vnApi.getRecordingsFromLink(nextPage);
                recordings.data.push(...moreRecordings.data);
                nextPage = moreRecordings.links.next;
            } while (nextPage);
        }

        if (recordings) {
            new Notice(`Syncing latest Voicenotes`);
            for (const recording of recordings.data) {
                await this.processNote(recording, voiceNotesDir);
            }
        }

        window.clearInterval(this.syncInterval);

        if (this.settings.automaticSync) {
            console.debug(`timeSinceSync ${this.timeSinceSync} - syncTimeout: ${this.settings.syncTimeout}`);
            this.syncInterval = window.setInterval(() => {
                this.timeSinceSync += this.ONE_SECOND;

                if (this.timeSinceSync >= this.settings.syncTimeout * 60 * 1000) {
                    this.timeSinceSync = 0;
                    this.sync();
                }
            }, this.ONE_SECOND);
        }
    }
}