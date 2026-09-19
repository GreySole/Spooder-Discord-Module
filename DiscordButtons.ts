import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import DiscordSelectMenus, { DiscordSelectMenuDef } from './DiscordSelectMenus';

// Discord's own ceilings. A message carries at most five action rows of five buttons each, and
// a label is capped at 80 characters; exceeding any of them is rejected by the API rather than
// trimmed, so all three are enforced here - the values coming in are whatever someone typed
// into a node.
const BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5;
const MAX_LABEL_LENGTH = 80;

// The four styles a clickable button can take. Discord's ButtonStyle also has Link and Premium,
// but neither carries a customId - the API types spell this out, restricting a custom-id button
// to exactly these four - so neither can be an interaction button and neither is offered.
// Keep the keys in step with BUTTON_STYLE_SELECTIONS in the editor's nodeDefLookup.
export const BUTTON_STYLES: { [name: string]: ButtonStyle } = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

const DEFAULT_BUTTON_STYLE = ButtonStyle.Primary;

export interface DiscordButtonDef {
  // Becomes the interaction's customId, and is the exec port the graph branches on. Positional
  // ('component0', the slot it was plugged into), never derived from the label, so renaming a button can't move a wire.
  id: string;
  label: string;
  // A key of BUTTON_STYLES. Unset - a slot grown after the node was created, or one left on the
  // picker's 'None' - is Primary, which is Discord's own default for a plain button.
  style?: string;
}

// A slot on an interaction node, resolved: either a button or a select menu, tagged so the
// layout and the click handler can tell which without re-deriving it from the fields.
export type DiscordComponentDef =
  | ({ kind: 'button' } & DiscordButtonDef)
  | ({ kind: 'select' } & DiscordSelectMenuDef);

export default function DiscordButtons() {
  function makeLinkButton(label: string, url: string) {
    const button = new ButtonBuilder().setLabel(label).setURL(url).setStyle(ButtonStyle.Link);
    const row = new ActionRowBuilder().addComponents(button);
    return row;
  }

  function makeButton(button: DiscordButtonDef) {
    return new ButtonBuilder()
      .setCustomId(button.id)
      .setLabel(button.label.slice(0, MAX_LABEL_LENGTH))
      .setStyle(BUTTON_STYLES[button.style ?? ''] ?? DEFAULT_BUTTON_STYLE);
  }

  // Lays the components out in the order they were plugged in. Consecutive buttons pack five to
  // a row - the rows are a layout detail of the message, not something the graph should have to
  // think about - and a select menu always takes a row to itself, closing the one before it.
  // Anything past Discord's five rows is dropped rather than rejecting the whole message.
  function makeComponentRows(components: DiscordComponentDef[]) {
    const selectMenus = DiscordSelectMenus();
    const rows: ActionRowBuilder<any>[] = [];
    let buttonRow: ActionRowBuilder<ButtonBuilder> | undefined;
    for (const component of components) {
      if (component.kind === 'button') {
        if (!buttonRow || buttonRow.components.length === BUTTONS_PER_ROW) {
          buttonRow = new ActionRowBuilder<ButtonBuilder>();
          rows.push(buttonRow);
        }
        buttonRow.addComponents(makeButton(component));
        continue;
      }
      buttonRow = undefined;
      rows.push(...selectMenus.makeSelectMenus([component]));
    }
    return rows.slice(0, MAX_ROWS);
  }

  return { makeLinkButton, makeComponentRows };
}
