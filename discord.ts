import {
  ApplicationCommandOptionType,
  ChannelType,
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
} from 'discord.js';
import fs from 'fs';
import { logEffects, spooderLog } from '../../core/Logging';
import { backoffDelay } from '../../core/util/BackoffUtil';
import PluginService from '../../core/service/PluginService';
import { CommunityModuleInterface } from '../../interface/CommunityModuleInterface';
import {
  ActionExecutionContext,
  ActionNodeDef,
  KeyedObject,
  NodeForm,
  NodePortDef,
  OperationNodeDef,
  TriggerNodeDef,
  userDir,
} from '../../Types';
import DiscordApi from './DiscordApi';
import DiscordButtons, { DiscordComponentDef } from './DiscordButtons';
import DiscordChat from './DiscordChat';
import getDiscordRouters from './DiscordRouter';
import DiscordVoice from './DiscordVoice';

// How long a login gets to reach ready before it is treated as failed and retried.
const READY_TIMEOUT_MS = 45000;

// discord.js error codes / gateway close codes a retry can't fix: a rejected token, or intents
// the application hasn't been granted. Retrying these forever would only repeat the same log.
const UNRETRYABLE_LOGIN_ERRORS = ['TokenInvalid', 'TokenMissing', 'DisallowedIntents', 'InvalidIntents'];
const UNRETRYABLE_CLOSE_CODES = [4004, 4010, 4011, 4012, 4013, 4014];

export function discordLog(...content: any[]) {
  console.log(logEffects('Bright'), logEffects('FgCyan'), ...content, logEffects('Reset'));
}

// The interaction nodes take their buttons and select menus as plugged-in Button / Select Menu
// nodes, one per `component0`..`componentN-1` slot. The slot name is the field name, the
// interaction's customId and the exec port id all at once, which is what lets a click name its
// own branch - and being positional rather than derived from a label, renaming a component can't
// move a wire. The editor grows the same slots (see buildInteractionForm in nodeDefLookup.ts);
// keep MAX_COMPONENT_SLOTS in step with it.
const MAX_COMPONENT_SLOTS = 25;

const SELECT_MENU_TYPES = ['string', 'user', 'role', 'mentionable', 'channel'];

// Parses a String Select's options out of its textarea: one option per line, as
// 'value|Label|description' - only value is required, and a line with nothing on it is skipped
// rather than becoming a blank, unclickable option.
function parseSelectOptions(raw: string): { value: string; label: string; description?: string }[] {
  return String(raw ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [value, label, description] = line.split('|').map((part) => part?.trim() ?? '');
      return { value, label: label || value, description: description || undefined };
    })
    .filter((option) => option.value.length > 0);
}

// What the Button and Select Menu nodes output. Plain objects tagged with `kind`, since a port
// carries no structure of its own - the interaction node tells the two apart by the tag.
function evaluateDiscordOperationNode(nodeId: string, values: KeyedObject): KeyedObject {
  switch (nodeId) {
    case 'discord_button':
      return {
        component: {
          kind: 'button',
          // Discord rejects a button with no label, and a slot the user has plugged in but not
          // named still has to exist or the branches would stop matching the buttons.
          label: String(values.label ?? '').trim() || 'Button',
          style: String(values.style ?? ''),
        },
      };
    case 'discord_select_menu': {
      const type = SELECT_MENU_TYPES.includes(values.type) ? values.type : 'string';
      return {
        component: {
          kind: 'select',
          type,
          placeholder: String(values.placeholder ?? ''),
          minValues: Number(values.minValues) || 1,
          maxValues: Number(values.maxValues) || 1,
          options: type === 'string' ? parseSelectOptions(values.options) : undefined,
        },
      };
    }
    default:
      return {};
  }
}

// Reads whatever is plugged into the node's slots, in slot order. A slot with nothing plugged in
// - or something that isn't a Button / Select Menu node's output - is skipped, not an error, so
// a gap in the middle doesn't take the rest of the message with it.
function interactionComponents(values: KeyedObject): DiscordComponentDef[] {
  const components: DiscordComponentDef[] = [];
  for (let i = 0; i < MAX_COMPONENT_SLOTS; i++) {
    const component = values[`component${i}`];
    const id = `component${i}`;
    if (component?.kind === 'button') {
      components.push({ kind: 'button', id, label: component.label, style: component.style });
    } else if (component?.kind === 'select') {
      components.push({ ...component, kind: 'select', id });
    }
  }
  return components;
}

// The plug-in slots, in the order the message shows them. The first is always offered; the rest
// are `growable`, so the editor reveals each once the one before it has something plugged in.
// `growGroup` keeps that check to the slots themselves rather than the destination and message
// fields that sit above them. Wire-only: a slot has no value to type.
function componentSlots(): NodeForm {
  const form: NodeForm = {};
  for (let i = 0; i < MAX_COMPONENT_SLOTS; i++) {
    form[`component${i}`] = {
      label: `Component ${i + 1}`,
      type: 'port',
      portType: 'any',
      growable: i >= 1,
      growGroup: 'components',
    };
  }
  return form;
}

// Used when the node's own wait is missing or nonsensical. Discord's collectors have no
// implicit ceiling, and a prompt nobody answers would otherwise hold its branch forever.
const DEFAULT_INTERACTION_WAIT = 60;

// Everything both interaction nodes share: the message, the plugged-in components, how long to
// wait, and what comes back. Only where the prompt is posted differs.
const INTERACTION_FORM: NodeForm = {
  message: {
    label: 'Message',
    type: 'textarea',
    portType: 'string',
  },
  ...componentSlots(),
  timeout: { label: 'Wait (seconds)', type: 'number', portType: 'number' },
};

const INTERACTION_DEFAULTS = {
  message: '',
  timeout: DEFAULT_INTERACTION_WAIT,
};

const INTERACTION_OUTPUTS: NodePortDef[] = [
  { id: 'buttonId', label: 'Button ID', dataType: 'string' },
  { id: 'buttonLabel', label: 'Button Label', dataType: 'string' },
  { id: 'selectMenuId', label: 'Select Menu ID', dataType: 'string' },
  // Everything chosen across every select menu, in message order - a String Select's option
  // values, or the picked users'/roles'/channels' ids as strings for the other four kinds. Each
  // plugged-in menu also gets its own outputs, added by the editor.
  { id: 'values', label: 'Selected Values', dataType: 'any' },
  // The common case is a single menu with one pick - this is values[0], so a graph that doesn't
  // care about multi-select doesn't have to unpack an array.
  { id: 'value', label: 'Selected Value', dataType: 'string' },
  { id: 'userId', label: 'User ID', dataType: 'string' },
  { id: 'username', label: 'Username', dataType: 'string' },
  { id: 'messageId', label: 'Message ID', dataType: 'string' },
];

// A branch per plugged-in component is added to this by the editor, which is the only side that
// knows what is wired where. Declaring the timeout branch here keeps the node branching even
// before anything is plugged in.
const INTERACTION_EXEC_OUTPUTS = [{ id: 'timeout', label: 'Timed Out' }];

export default class Discord implements CommunityModuleInterface {
  client: Client<boolean> | undefined;

  voice!: DiscordVoice;
  api!: DiscordApi;
  chat!: DiscordChat;
  buttons = DiscordButtons();
  guilds = null;
  loggedIn = false;
  commands = new Collection();
  lastMessage = {} as KeyedObject;

  constructor() {}

  getRouters = getDiscordRouters;

  onExternalNetworkChanged() {}
  getResponseHandlers() {
    return { descriptions: [], functions: {} };
  }

  config = fs.existsSync(userDir + '/settings/discord.json')
    ? JSON.parse(fs.readFileSync(userDir + '/settings/discord.json', { encoding: 'utf-8' }))
    : {
        master: '',
        token: '',
        clientId: '',
        autosendngrok: {
          enabled: false,
          destguild: '',
          destchannel: '',
        },
        handlers: {},
        commands: [],
        sharenotif: false,
        crashreport: false,
      };

  sendDM = (userId: string, message: string) => {};
  sendToChannel = (server: string, channel: string, message: string, components?: any[]) => {};

  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;

  async autoLogin(): Promise<boolean> {
    if (this.config.token == '' || this.config.token == null) {
      discordLog('No Discord token.');
      return false;
    }
    discordLog('STARTING DISCORD CLIENT');
    // A login someone asked for supersedes any retry already waiting on its backoff.
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectAttempts = 0;
    return this.connect();
  }

  // One login attempt. A failure schedules another rather than leaving the bot offline until
  // someone restarts Spooder - except for the ones no amount of retrying will fix, like a
  // rejected token, where the log line is the useful part.
  private async connect(): Promise<boolean> {
    try {
      await this.startClient(this.config.token);
      return true;
    } catch (error: any) {
      this.loggedIn = false;
      discordLog('Discord login failed:', error?.message ?? error);
      if (!UNRETRYABLE_LOGIN_ERRORS.includes(error?.code)) {
        this.scheduleReconnect();
      }
      return false;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }
    const delay = backoffDelay(this.reconnectAttempts++);
    discordLog(`Reconnecting to Discord in ${delay / 1000}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  startClient(token: string) {
    return new Promise((res, rej) => {
      // A client left over from an earlier attempt or a dead connection is torn down first,
      // listeners included: it would otherwise keep reconnecting in the background and handle
      // every event a second time alongside its replacement.
      if (this.client) {
        this.client.removeAllListeners();
        this.client.destroy().catch(() => {});
      }
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildIntegrations,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildVoiceStates,
          GatewayIntentBits.GuildModeration,
          // Reactions, and the emoji list the Reaction Added node picks from. Neither is a
          // privileged intent, so both are on by default rather than needing anything enabled
          // in the Discord developer portal - unlike MessageContent above.
          GatewayIntentBits.GuildMessageReactions,
          GatewayIntentBits.DirectMessageReactions,
          GatewayIntentBits.GuildExpressions,
        ],
        // A reaction on a message the bot didn't watch arrive - anything older than the current
        // session, which is most messages - is delivered with the message, the reaction and the
        // user all uncached. Without these partials discord.js drops that event entirely rather
        // than handing over a stub to fetch from.
        partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
      });

      const client = this.client;
      // login() can resolve and the gateway still never become ready (the connection drops
      // in between), which would leave this promise - and the boot waiting on it - hanging.
      const readyTimeout = setTimeout(() => {
        client.removeAllListeners();
        client.destroy().catch(() => {});
        rej(new Error('Timed out waiting for Discord to become ready'));
      }, READY_TIMEOUT_MS);

      client.once(Events.ClientReady, (c) => {
        clearTimeout(readyTimeout);
        // The services below bind to the client, so they are built per client - once it is
        // actually ready - rather than ahead of a login that may fail and be retried.
        this.api = new DiscordApi();
        this.voice = new DiscordVoice();
        this.chat = new DiscordChat();
        this.chat.init();
        this.sendDM = this.chat.sendDM.bind(this.chat);
        this.sendToChannel = this.chat.sendToChannel.bind(this.chat);

        this.loggedIn = true;
        this.reconnectAttempts = 0;
        discordLog('Discord Ready! Logged in as ' + c.user.tag, c.user);

        res('success');
      });

      // discord.js reconnects and resumes a dropped gateway on its own; these only keep
      // `loggedIn` honest while it does, so nothing reports a connection that isn't there.
      client.on(Events.ShardReconnecting, () => {
        this.loggedIn = false;
        discordLog('Discord connection lost, reconnecting...');
      });
      client.on(Events.ShardResume, () => {
        this.loggedIn = true;
        discordLog('Discord connection restored.');
      });
      client.on(Events.ShardReady, () => {
        this.loggedIn = true;
      });
      // The shard is not coming back by itself: discord.js only emits this for a close it
      // won't recover from. A new client is the way back, unless the reason is one a new
      // client would hit again.
      client.on(Events.ShardDisconnect, (closeEvent) => {
        if (client !== this.client) {
          return;
        }
        this.loggedIn = false;
        discordLog('Discord connection closed for good, code ' + closeEvent.code);
        if (!UNRETRYABLE_CLOSE_CODES.includes(closeEvent.code)) {
          this.scheduleReconnect();
        }
      });
      client.on(Events.Invalidated, () => {
        if (client !== this.client) {
          return;
        }
        this.loggedIn = false;
        discordLog('Discord session invalidated.');
        this.scheduleReconnect();
      });

      client.login(token).catch((error) => {
        clearTimeout(readyTimeout);
        rej(error);
      });
    });
  }

  getPluginFunctions = () => {
    if (this.loggedIn === false) {
      return {};
    }
    return {
      isSelf: this.api.isSelf.bind(this.api),
      isMaster: this.api.isMaster.bind(this.api),
      isHandler: this.api.isHandler.bind(this.api),
      getChannel: this.api.getChannel.bind(this.api),
      getMessageRange: this.api.getMessageRange.bind(this.api),
      getRoles: this.api.getRoles.bind(this.api),
      getUser: this.api.getUser.bind(this.api),
      findUser: this.api.findUser.bind(this.api),
      sendDM: this.chat.sendDM.bind(this.chat),
      voice: {
        join: this.voice.joinVoiceChannel.bind(this.voice),
        leave: this.voice.leaveVoiceChannel.bind(this.voice),
        playSound: this.voice.playAudio.bind(this.voice),
        startListening: this.voice.startListening.bind(this.voice),
        stopListening: this.voice.stopListening.bind(this.voice),
      },
    };
  };

  getTriggerNodes = (): TriggerNodeDef[] => {
    return [
      {
        id: 'message_received',
        label: 'Message Received',
        description: 'Fires when a message is posted in a server channel or DM.',
        form: {
          // The same pickers the Reaction Added trigger filters with - an 18-digit id says
          // nothing about what it points at, and a wrong one fails silently at run time. Both
          // still store a plain id string, so a filter typed in by hand before these were
          // pickers keeps working (FormDiscordIdSelect shows an unlisted id in manual mode).
          guildId: {
            label: 'Guild (optional filter)',
            type: 'custom',
            options: { component: 'guildSelect' },
          },
          channelId: {
            label: 'Channel (optional filter)',
            type: 'custom',
            options: {
              component: 'channelIdSelect',
              guildField: 'guildId',
              channelTypes: ['text'],
            },
          },
          requireMention: { label: 'Require Bot Mention', type: 'boolean' },
        },
        defaults: { guildId: '', channelId: '', requireMention: false },
        outputs: [
          { id: 'username', label: 'Username', dataType: 'string' },
          { id: 'userId', label: 'User ID', dataType: 'string' },
          { id: 'message', label: 'Message Content', dataType: 'string' },
          { id: 'messageId', label: 'Message ID', dataType: 'string' },
          { id: 'guildId', label: 'Guild ID', dataType: 'string' },
          { id: 'channelId', label: 'Channel ID', dataType: 'string' },
        ],
      },
      {
        id: 'reaction_added',
        label: 'Reaction Added',
        description:
          'Fires when someone reacts to a message. Leave a filter empty to fire for any guild, channel or emoji.',
        form: {
          guildId: {
            label: 'Guild (optional filter)',
            type: 'custom',
            options: { component: 'guildSelect' },
          },
          channelId: {
            label: 'Channel (optional filter)',
            type: 'custom',
            options: {
              component: 'channelIdSelect',
              guildField: 'guildId',
              channelTypes: ['text'],
            },
          },
          emoji: {
            label: 'Emoji (optional filter)',
            type: 'custom',
            options: { component: 'emojiSelect' },
          },
        },
        defaults: { guildId: '', channelId: '', emoji: '' },
        outputs: [
          // The same composite the emoji picker stores and matchesTriggerValues compares on:
          // 'name:id' for a custom emoji, the character itself for a standard one.
          { id: 'emoji', label: 'Emoji', dataType: 'string' },
          { id: 'emojiName', label: 'Emoji Name', dataType: 'string' },
          { id: 'emojiId', label: 'Emoji ID', dataType: 'string' },
          // Ready to paste into a message or reply - '<:name:id>' for a custom emoji, and the
          // character for a standard one, which needs no markup.
          { id: 'emojiMarkup', label: 'Emoji Markup', dataType: 'string' },
          { id: 'isCustom', label: 'Is Custom Emoji', dataType: 'boolean' },
          { id: 'count', label: 'Reaction Count', dataType: 'number' },
          { id: 'messageId', label: 'Message ID', dataType: 'string' },
          { id: 'messageContent', label: 'Message Content', dataType: 'string' },
          { id: 'username', label: 'Username', dataType: 'string' },
          { id: 'userId', label: 'User ID', dataType: 'string' },
          { id: 'guildId', label: 'Guild ID', dataType: 'string' },
          { id: 'channelId', label: 'Channel ID', dataType: 'string' },
        ],
      },
    ];
  };

  getOperationNodes = (): OperationNodeDef[] => {
    return [
      {
        id: 'discord_button',
        label: 'Discord Button',
        description:
          'Defines one button. Plug it into a Send Server Interaction or Send Direct Interaction node, which posts it with its message and gives it its own execution branch.',
        category: 'discord',
        form: {
          label: { label: 'Label', type: 'text', portType: 'string' },
          // No portType: a style is a fixed choice from four, not something worth wiring.
          style: {
            label: 'Style',
            type: 'select',
            options: {
              selections: {
                primary: 'Primary (blurple)',
                secondary: 'Secondary (grey)',
                success: 'Success (green)',
                danger: 'Danger (red)',
              },
            },
          },
        },
        defaults: { label: '', style: 'primary' },
        outputs: [{ id: 'component', label: 'Button', dataType: 'any' }],
      },
      {
        id: 'discord_select_menu',
        label: 'Discord Select Menu',
        description:
          'Defines one dropdown. Plug it into a Send Server Interaction or Send Direct Interaction node. A String Select offers the options you list; the other kinds are filled in by Discord from the server. What was picked comes out of the interaction node as Selected Value(s).',
        category: 'discord',
        form: {
          type: {
            label: 'Type',
            type: 'select',
            options: {
              selections: {
                string: 'String Select (custom options)',
                user: 'User Select',
                role: 'Role Select',
                mentionable: 'User or Role Select',
                channel: 'Channel Select',
              },
            },
          },
          placeholder: { label: 'Placeholder', type: 'text', portType: 'string' },
          minValues: { label: 'Min Values', type: 'number', portType: 'number' },
          maxValues: { label: 'Max Values', type: 'number', portType: 'number' },
          // Only String Select takes options. One per line as 'value|Label|description'; only
          // value is required.
          options: {
            label: 'Options (value|Label|description per line)',
            type: 'textarea',
            portType: 'string',
            showif: { variable: 'type', condition: 'equals', value: 'string' },
          },
        },
        defaults: { type: 'string', placeholder: '', minValues: 1, maxValues: 1, options: '' },
        outputs: [{ id: 'component', label: 'Select Menu', dataType: 'any' }],
      },
    ];
  };

  evaluateOperationNode = (nodeId: string, values: KeyedObject) =>
    evaluateDiscordOperationNode(nodeId, values);

  getActionNodes = (): ActionNodeDef[] => {
    return [
      {
        id: 'send_dm',
        label: 'Send Direct Message',
        form: {
          userId: { label: 'User ID', type: 'text', portType: 'string' },
          message: {
            label: 'Message',
            type: 'textarea',
            portType: 'string',
          },
        },
        defaults: { userId: '', message: '' },
      },
      {
        id: 'message',
        label: 'Send To Channel',
        form: {
          destination: {
            label: 'Send To',
            type: 'custom',
            options: { component: 'channelSelect', channelTypes: ['text'] },
          },
          message: {
            label: 'Message',
            type: 'textarea',
            portType: 'string',
          },
          // Scoped to the guild the destination points at - a role id from another guild is
          // meaningless here. Still a string port: a graph can wire one in instead.
          role: {
            label: 'Role To Tag',
            type: 'custom',
            options: { component: 'roleSelect', guildField: 'destination.destguild' },
            portType: 'string',
          },
          use_link_button: { label: 'Include Link Button', type: 'boolean' },
          link_url: {
            label: 'Link URL',
            type: 'text',
            portType: 'string',
            showif: { variable: 'use_link_button', condition: 'equals', value: true },
          },
          link_label: {
            label: 'Link Button Label',
            type: 'text',
            portType: 'string',
            showif: { variable: 'use_link_button', condition: 'equals', value: true },
          },
        },
        defaults: {
          destination: { destguild: '', destchannel: '' },
          message: '',
          role: '',
          use_link_button: false,
          link_url: '',
          link_label: '',
        },
      },
      {
        id: 'interaction_send',
        label: 'Send Server Interaction',
        description:
          'Posts a message with buttons and select menus in a server channel and waits for someone to use one. Plug Discord Button and Discord Select Menu nodes into the Component slots. With any button plugged in, menus only record what was picked (read the picks from the outputs named after that menu) and a button click ends the wait on the branch of the button clicked - so a menu plus a Confirm or Cancel button works. With menus alone, the first pick ends the wait on that branch. Timed Out runs if nobody answers before the wait is up. The components are removed from the message either way, so a prompt is answered once.',
        form: {
          destination: {
            label: 'Send To',
            type: 'custom',
            options: { component: 'channelSelect', channelTypes: ['text'] },
          },
          ...INTERACTION_FORM,
        },
        defaults: {
          destination: { destguild: '', destchannel: '' },
          ...INTERACTION_DEFAULTS,
        },
        outputs: INTERACTION_OUTPUTS,
        execOutputs: INTERACTION_EXEC_OUTPUTS,
      },
      {
        id: 'interaction_send_dm',
        label: 'Send Direct Interaction',
        description:
          "Sends a user a direct message with buttons and select menus and waits for them to use one. Behaves like Send Server Interaction otherwise. A user who has direct messages from server members turned off can't be reached, and that takes the Timed Out branch.",
        form: {
          userId: { label: 'User ID', type: 'text', portType: 'string' },
          ...INTERACTION_FORM,
        },
        defaults: { userId: '', ...INTERACTION_DEFAULTS },
        outputs: INTERACTION_OUTPUTS,
        execOutputs: INTERACTION_EXEC_OUTPUTS,
      },
      {
        id: 'reply',
        label: 'Reply To Message',
        description:
          'Replies to an existing Discord message, quoting it the way the client does. Left blank, the message and channel are the ones that triggered this event - so a Reply wired straight to Message Received answers that message.',
        form: {
          messageId: { label: 'Message ID', type: 'text', portType: 'string' },
          channelId: { label: 'Channel ID', type: 'text', portType: 'string' },
          message: {
            label: 'Message',
            type: 'textarea',
            portType: 'string',
          },
        },
        defaults: { messageId: '', channelId: '', message: '' },
        outputs: [{ id: 'replyMessageId', label: 'Reply Message ID', dataType: 'string' }],
      },
      {
        id: 'react',
        label: 'React To Message',
        description:
          'Adds a reaction to an existing Discord message as the bot. Left blank, the message and channel are the ones that triggered this event - so a React wired to Reaction Added reacts back to what someone just reacted to. Pick a custom emoji with the browser, or paste/type a standard one into the field.',
        form: {
          messageId: { label: 'Message ID', type: 'text', portType: 'string' },
          channelId: { label: 'Channel ID', type: 'text', portType: 'string' },
          // Same picker - and therefore the same 'name:id' value - as the Reaction Added
          // trigger's filter, so that node's Emoji output can be wired straight in. No guild
          // field to scope it to here, so the browser offers every emoji the bot can see.
          emoji: {
            label: 'Emoji',
            type: 'custom',
            options: { component: 'emojiSelect', placeholder: 'Emoji or :name:id' },
            portType: 'string',
          },
        },
        defaults: { messageId: '', channelId: '', emoji: '' },
      },
      {
        id: 'voice_join',
        label: 'Join Voice Channel',
        form: {
          guildId: {
            label: 'Guild',
            type: 'custom',
            options: { component: 'guildSelect' },
            portType: 'string',
          },
          // Voice and stage only: joining a text channel is not a thing the voice client can do.
          channelId: {
            label: 'Channel',
            type: 'custom',
            options: {
              component: 'channelIdSelect',
              guildField: 'guildId',
              channelTypes: ['voice'],
            },
            portType: 'string',
          },
        },
        defaults: { guildId: '', channelId: '' },
      },
      {
        id: 'voice_leave',
        label: 'Leave Voice Channel',
        form: {},
        defaults: {},
      },
      {
        id: 'voice_play_sound',
        label: 'Play Sound In Voice Channel',
        form: {
          sound: {
            label: 'Sound',
            type: 'asset',
            options: { assetType: 'sound', folder: 'sound', required: true },
          },
        },
        defaults: { sound: '' },
      },
    ];
  };

  executeActionNode = (nodeId: string, values: KeyedObject, ctx: ActionExecutionContext) => {
    return async () => {
      try {
        switch (nodeId) {
          case 'send_dm': {
            this.chat.sendDM(values.userId, String(values.message ?? ''));
            break;
          }
          case 'message': {
            const components = [];
            if (values.use_link_button) {
              components.push(
                this.buttons.makeLinkButton(values.link_label || 'Button', values.link_url),
              );
            }

            const roleTag = values.role ? this.chat.makeRoleTag(values.role) : null;

            this.chat.sendToChannel(
              values.destination?.destguild ?? values.guild,
              values.destination?.destchannel ?? '',
              `${roleTag ? roleTag + ' ' : ''}${String(values.message ?? '')}`,
              components,
            );
            break;
          }
          case 'interaction_send':
          case 'interaction_send_dm': {
            const message = String(values.message ?? '');
            const components = interactionComponents(values);
            const timeout = Number(values.timeout);
            const wait =
              Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_INTERACTION_WAIT;

            const result =
              nodeId === 'interaction_send_dm'
                ? await this.chat.sendDirectButtonPrompt(
                    values.userId,
                    message,
                    components,
                    wait,
                  )
                : await this.chat.sendButtonPrompt(
                    values.destination?.destchannel ?? '',
                    message,
                    components,
                    wait,
                  );
            return {
              ...result,
              // The branch this node takes. A click or a selection follows the slot that fired
              // it - the customId and the exec port id are the same string by construction - and
              // anything else, a timeout or a prompt that never sent, ends up on Timed Out
              // rather than leaving the graph with nowhere to go.
              execPort: result.buttonId || result.selectMenuId || 'timeout',
            };
          }
          case 'reply': {
            // Both ids fall back to the message this event fired for. That is the common
            // shape of a reply graph, and it keeps the node usable with nothing wired into it.
            const eventData = ctx.streamMessage.platformEventData ?? {};
            const messageId = values.messageId || eventData.messageId || '';
            const channelId =
              values.channelId || eventData.channelId || ctx.streamMessage.channel || '';
            const sent = await this.chat.replyToMessage(
              channelId,
              messageId,
              String(values.message ?? ''),
            );
            return { replyMessageId: sent?.id ?? '' };
          }
          case 'react': {
            // Both ids fall back to the message this event fired for, the same way Reply does:
            // reacting to the triggering message is the common case, and it keeps the node
            // useful with nothing wired into it.
            const eventData = ctx.streamMessage.platformEventData ?? {};
            const messageId = values.messageId || eventData.messageId || '';
            const channelId =
              values.channelId || eventData.channelId || ctx.streamMessage.channel || '';
            await this.chat.reactToMessage(channelId, messageId, String(values.emoji ?? '').trim());
            break;
          }
          case 'voice_join':
            this.voice.joinVoiceChannel(values.guildId, values.channelId);
            break;
          case 'voice_leave':
            this.voice.leaveVoiceChannel();
            break;
          case 'voice_play_sound':
            this.voice.playAudio(values.sound);
            break;
          default:
            spooderLog(`Unknown discord action node '${nodeId}' for event ${ctx.eventName}`);
        }
      } catch (e) {
        spooderLog(
          `Failed to execute discord action '${nodeId}' for ${ctx.eventName}. Check the event settings to verify it.`,
          e,
        );
      }
    };
  };

  convertSlashCommandOptionType(type: string) {
    ChannelType.GuildText;
    ChannelType.GuildVoice;
    switch (type) {
      case 'string':
        return ApplicationCommandOptionType.String;
      case 'integer':
        return ApplicationCommandOptionType.Integer;
      case 'number':
        return ApplicationCommandOptionType.Number;
      case 'boolean':
        return ApplicationCommandOptionType.Boolean;
      case 'user':
        return ApplicationCommandOptionType.User;
      case 'attachment':
        return ApplicationCommandOptionType.Attachment;
      case 'channel':
        return ApplicationCommandOptionType.Channel;
      case 'role':
        return ApplicationCommandOptionType.Role;
      case 'mentionable':
        return ApplicationCommandOptionType.Mentionable;
      case 'sub_command':
        return ApplicationCommandOptionType.Subcommand;
      case 'sub_command_group':
        return ApplicationCommandOptionType.SubcommandGroup;
      default:
        return ApplicationCommandOptionType.String; // Default to STRING
    }
  }

  async onPluginsLoaded() {
    const activePlugins = PluginService.getActivePlugins();
    let discordInfo = this.config;
    if (discordInfo.commands) {
      discordLog('FOUND COMMANDS');
      let dCommands = discordInfo.commands;
      for (let d in dCommands) {
        this.commands.set(dCommands[d].name, dCommands[d]);
      }
    }
    for (let p in activePlugins) {
      const slashCommands = activePlugins[p].getExtra('dSlashCommands');
      if (slashCommands) {
        for (let d in slashCommands) {
          console.log('ADDING SLASH COMMAND', slashCommands[d]);
          for (let o in slashCommands[d].options) {
            if (!isNaN(slashCommands[d].options[o].type)) {
              continue;
            }
            slashCommands[d].options[o].type = this.convertSlashCommandOptionType(
              slashCommands[d].options[o].type,
            );
          }
          this.commands.set(slashCommands[d].name, slashCommands[d]);
        }
      }
    }
    if (this.commands.size > 0) {
      //console.log(`Started refreshing ${this.commands.size} application (/) commands.`);
      const rest = new REST({ version: '10' }).setToken(discordInfo.token);
      const data: any = await rest.put(Routes.applicationCommands(discordInfo.clientId), {
        body: this.commands,
      });
      console.log(this.commands);
      discordLog(`Successfully reloaded ${data.length} application (/) commands.`);
    }
  }
}
