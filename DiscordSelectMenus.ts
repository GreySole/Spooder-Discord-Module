import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  MentionableSelectMenuBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} from 'discord.js';

// Discord's own ceiling: a message carries at most five action rows, and a select menu always
// fills a whole row by itself - so five is the most a message can ever hold, buttons or not.
export const MAX_SELECT_MENUS = 5;

const MAX_PLACEHOLDER_LENGTH = 150;

export type DiscordSelectMenuType = 'string' | 'user' | 'role' | 'mentionable' | 'channel';

export interface DiscordSelectOption {
  value: string;
  label: string;
  description?: string;
}

export interface DiscordSelectMenuDef {
  // Becomes the interaction's customId, and is the exec port the graph branches on - the same
  // positional, never-derived-from-content id scheme DiscordButtonDef uses, for the same reason.
  id: string;
  type: DiscordSelectMenuType;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  // Only meaningful for a 'string' menu - the other four kinds are populated by Discord itself
  // from the guild, so they take no options at all.
  options?: DiscordSelectOption[];
}

export default function DiscordSelectMenus() {
  // Builds one action row per def - a select menu can't share a row with anything else, unlike
  // buttons which pack five to a row.
  function makeSelectMenus(menus: DiscordSelectMenuDef[]) {
    const rows: ActionRowBuilder<any>[] = [];
    for (const menu of menus.slice(0, MAX_SELECT_MENUS)) {
      const builder = makeSelectMenuBuilder(menu);
      if (!builder) {
        continue;
      }
      rows.push(new ActionRowBuilder().addComponents(builder));
    }
    return rows;
  }

  function makeSelectMenuBuilder(menu: DiscordSelectMenuDef) {
    const minValues = Math.max(1, Math.floor(menu.minValues ?? 1));
    const maxValues = Math.max(minValues, Math.floor(menu.maxValues ?? 1));
    const placeholder = (menu.placeholder ?? '').slice(0, MAX_PLACEHOLDER_LENGTH);

    switch (menu.type) {
      case 'string': {
        const options = (menu.options ?? []).slice(0, 25);
        // Discord rejects a string select with no options outright, so a menu grown but left
        // empty is dropped rather than sent broken.
        if (options.length === 0) {
          return null;
        }
        return new StringSelectMenuBuilder()
          .setCustomId(menu.id)
          .setPlaceholder(placeholder)
          .setMinValues(minValues)
          .setMaxValues(Math.min(maxValues, options.length))
          .addOptions(
            options.map((o) => ({
              value: o.value,
              label: o.label || o.value,
              description: o.description || undefined,
            })),
          );
      }
      case 'user':
        return new UserSelectMenuBuilder()
          .setCustomId(menu.id)
          .setPlaceholder(placeholder)
          .setMinValues(minValues)
          .setMaxValues(maxValues);
      case 'role':
        return new RoleSelectMenuBuilder()
          .setCustomId(menu.id)
          .setPlaceholder(placeholder)
          .setMinValues(minValues)
          .setMaxValues(maxValues);
      case 'mentionable':
        return new MentionableSelectMenuBuilder()
          .setCustomId(menu.id)
          .setPlaceholder(placeholder)
          .setMinValues(minValues)
          .setMaxValues(maxValues);
      case 'channel':
        return new ChannelSelectMenuBuilder()
          .setCustomId(menu.id)
          .setPlaceholder(placeholder)
          .setMinValues(minValues)
          .setMaxValues(maxValues);
      default:
        return null;
    }
  }

  return { makeSelectMenus };
}
