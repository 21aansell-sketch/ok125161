import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, i18n } from "@vendetta/metro/common";
import { before, after } from "@vendetta/patcher";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { findInReactTree } from "@vendetta/utils";

const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const ActionSheetRow =
    findByProps("ActionSheetRow")?.ActionSheetRow ?? Forms.FormRow;

const MessageStore = findByStoreName("MessageStore");
const UserStore = findByStoreName("UserStore");

// Discord 345009 still exposes the message editing actions through
// the message-actions module, but don't crash the plugin if Discord
// changes the module shape.
const Messages = findByProps(
    "sendMessage",
    "startEditMessage",
    "endEditMessage",
);

const edits = new Map<string, any>();

let isEditing = false;
let patches: (() => void)[] = [];

export default {
    onLoad() {
        if (!LazyActionSheet || !MessageStore || !UserStore || !Messages) {
            console.warn(
                "[LocalMessageEditor] Required Discord modules were not found."
            );
            return;
        }

        /*
         * Add "Edit Locally" to the message long-press menu.
         */
        patches.push(
            before(
                "openLazy",
                LazyActionSheet,
                ([component, key, msg]) => {
                    const message = msg?.message;

                    if (
                        key !== "MessageLongPressActionSheet" ||
                        !message
                    ) {
                        return;
                    }

                    component.then((instance: any) => {
                        if (!instance) return;

                        const unpatch = after(
                            "default",
                            instance,
                            (_args: any[], res: any) => {
                                setTimeout(unpatch, 0);

                                const buttons = findInReactTree(
                                    res,
                                    (x: any) =>
                                        x?.[0]?.type?.name ===
                                        "ActionSheetRow",
                                );

                                if (!buttons) return;

                                const currentUser =
                                    UserStore.getCurrentUser();

                                const currentMessage =
                                    MessageStore.getMessage(
                                        message.channel_id,
                                        message.id,
                                    ) ?? message;

                                if (!currentMessage?.author?.id) return;

                                // Don't offer the option for your own messages.
                                if (
                                    currentUser &&
                                    currentMessage.author.id ===
                                        currentUser.id
                                ) {
                                    return;
                                }

                                if (
                                    buttons.some(
                                        (b: any) =>
                                            b?.props?.label ===
                                            "Edit Locally",
                                    )
                                ) {
                                    return;
                                }

                                const unreadIndex = buttons.findIndex(
                                    (x: any) =>
                                        x?.props?.message ===
                                        i18n.Messages.MARK_UNREAD,
                                );

                                const position =
                                    unreadIndex >= 0
                                        ? unreadIndex
                                        : buttons.length;

                                const handleEdit = () => {
                                    isEditing = true;

                                    /*
                                     * Keep a copy of the original message.
                                     */
                                    if (!edits.has(currentMessage.id)) {
                                        edits.set(
                                            currentMessage.id,
                                            JSON.parse(
                                                JSON.stringify(
                                                    currentMessage,
                                                ),
                                            ),
                                        );
                                    }

                                    LazyActionSheet.hideActionSheet();

                                    /*
                                     * Open Discord's normal editor.
                                     *
                                     * We intercept the actual edit call
                                     * below, so Discord never receives the
                                     * edited message.
                                     */
                                    Messages.startEditMessage(
                                        currentMessage.channel_id,
                                        currentMessage.id,
                                        currentMessage.content ?? "",
                                    );
                                };

                                buttons.splice(
                                    position,
                                    0,
                                    (
                                        <ActionSheetRow
                                            label="Edit Locally"
                                            icon={
                                                <ActionSheetRow.Icon
                                                    source={getAssetIDByName(
                                                        "ic_edit_24px",
                                                    )}
                                                />
                                            }
                                            onPress={handleEdit}
                                        />
                                    ),
                                );
                            },
                        );
                    });
                },
            ),
        );

        /*
         * Intercept Discord's edit operation.
         *
         * The original message is saved locally, then a local
         * MESSAGE_UPDATE is dispatched instead of sending the edit
         * to Discord.
         */
        patches.push(
            before(
                "editMessage",
                Messages,
                (args: any[]) => {
                    const [channelId, messageId, message] = args;

                    if (!isEditing) return;

                    const baseMessage = edits.get(messageId);

                    if (!baseMessage) {
                        isEditing = false;
                        return;
                    }

                    FluxDispatcher.dispatch({
                        type: "MESSAGE_UPDATE",
                        message: {
                            ...baseMessage,

                            channel_id: channelId,
                            id: messageId,

                            content:
                                typeof message === "string"
                                    ? message
                                    : message?.content ??
                                      baseMessage.content,

                            /*
                             * Don't show Discord's normal edited state.
                             */
                            edited_timestamp: null,
                        },

                        /*
                         * Prevent other plugins from treating this as
                         * a normal Discord message edit.
                         */
                        otherPluginBypass: true,
                    });

                    /*
                     * Returning false prevents the original
                     * editMessage function from executing.
                     */
                    return false;
                },
            ),
        );

        /*
         * Discord calls this when the normal message editor closes.
         */
        if (typeof Messages.endEditMessage === "function") {
            patches.push(
                after(
                    "endEditMessage",
                    Messages,
                    () => {
                        isEditing = false;
                    },
                ),
            );
        }
    },

    onUnload() {
        patches.forEach((unpatch) => {
            try {
                unpatch();
            } catch {}
        });

        patches = [];

        edits.clear();
        isEditing = false;
    },
};
