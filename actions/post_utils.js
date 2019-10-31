// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {batchActions} from 'redux-batched-actions';
import {
    markChannelAsRead,
    markChannelAsUnread,
    markChannelAsViewed,
} from 'mattermost-redux/actions/channels';
import * as PostActions from 'mattermost-redux/actions/posts';
import {WebsocketEvents} from 'mattermost-redux/constants';
import * as PostSelectors from 'mattermost-redux/selectors/entities/posts';
import {getCurrentChannelId, isManuallyUnread} from 'mattermost-redux/selectors/entities/channels';
import {getCurrentUserId} from 'mattermost-redux/selectors/entities/users';
import {
    isFromWebhook,
    isSystemMessage,
    shouldIgnorePost,
} from 'mattermost-redux/utils/post_utils';

import {sendDesktopNotification} from 'actions/notification_actions.jsx';

import {ActionTypes} from 'utils/constants';

export function completePostReceive(post, websocketMessageProps) {
    return async (dispatch, getState) => {
        const state = getState();

        const rootPost = PostSelectors.getPost(state, post.root_id);
        if (post.root_id && !rootPost) {
            const {data: posts} = await dispatch(PostActions.getPostThread(post.root_id));
            if (posts) {
                dispatch(lastPostActions(post, websocketMessageProps));
            }

            return;
        }

        dispatch(lastPostActions(post, websocketMessageProps));
    };
}

export function lastPostActions(post, websocketMessageProps) {
    return (dispatch, getState) => {
        const currentChannelId = getCurrentChannelId(getState());

        if (post.channel_id === currentChannelId) {
            dispatch({
                type: ActionTypes.INCREASE_POST_VISIBILITY,
                data: post.channel_id,
                amount: 1,
            });
        }

        // Need manual dispatch to remove pending post

        const actions = [
            PostActions.receivedNewPost(post),
            {
                type: WebsocketEvents.STOP_TYPING,
                data: {
                    id: post.channel_id + post.root_id,
                    userId: post.user_id,
                    now: Date.now(),
                },
            },
        ];

        dispatch(batchActions(actions));

        // Still needed to update unreads

        dispatch(setChannelReadAndView(post, websocketMessageProps));

        dispatch(sendDesktopNotification(post, websocketMessageProps));

        dispatch(moveNewMessagesLineForNewPost(post));
    };
}

export function setChannelReadAndView(post, websocketMessageProps) {
    return (dispatch, getState) => {
        const state = getState();
        if (shouldIgnorePost(post)) {
            return;
        }

        let markAsRead = false;
        let markAsReadOnServer = false;
        if (!isManuallyUnread(getState(), post.channel_id)) {
            if (
                post.user_id === getCurrentUserId(state) &&
                !isSystemMessage(post) &&
                !isFromWebhook(post)
            ) {
                markAsRead = true;
                markAsReadOnServer = false;
            } else if (
                post.channel_id === getCurrentChannelId(state) &&
                window.isActive
            ) {
                markAsRead = true;
                markAsReadOnServer = true;
            }
        }

        if (markAsRead) {
            dispatch(markChannelAsRead(post.channel_id, null, markAsReadOnServer));
            dispatch(markChannelAsViewed(post.channel_id));
        } else {
            dispatch(markChannelAsUnread(websocketMessageProps.team_id, post.channel_id, websocketMessageProps.mentions));
        }
    };
}

// moveNewMessagesLineForNewPost updates the position of the new messages line to be below the newly created post
// if the line was previously at the bottom of the channel and the post was made by the current user.
export function moveNewMessagesLineForNewPost(newPost) {
    return (dispatch, getState) => {
        const state = getState();
        const currentUserId = getCurrentUserId(state);

        if (newPost.user_id !== currentUserId || (newPost.props && newPost.props.from_webhook === 'true')) {
            // This post isn't from the current user, so we should show the New Messages line
            return;
        }

        const recent = PostSelectors.getRecentPostsChunkInChannel(state, newPost.channel_id);
        if (!recent) {
            // We don't know if the user is at the bottom of the channel, so we can't move the New Messages line
            return;
        }

        const allPosts = PostSelectors.getAllPosts(state);
        const newMessagesAt = state.views.channel.newMessagesAt;

        const mostRecentPost = allPosts[recent.order[0]];
        if (mostRecentPost.create_at >= newMessagesAt) {
            return;
        }

        dispatch({
            type: ActionTypes.UPDATE_NEW_MESSAGES_AT,
            data: {
                channelId: newPost.channel_id,
                newMessagesAt: newPost.create_at,
            },
        });
    };
}
