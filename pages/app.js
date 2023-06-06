import React, { useEffect, useRef, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { useRouter } from "next/router";
import { motion, AnimatePresence } from "framer-motion";

import Header from "../containers/Header";
import ChatBot from "../containers/ChatBot";
import CodeExplorer from "../containers/CodeExplorer";
import Spinner from "../components/Spinner";
import SubscriptionModal from "../containers/SubscriptionModal";

import Mixpanel from "../library/mixpanel";
import { Source, Message } from "../library/data";

const WELCOME_MESSAGE = "I'm here to help you understand your codebase. Get started by importing a GitHub repository or a code snippet. You can ask me to explain how something works, where something is implemented, or even how to debug an error."

export default function App() {
    const { isAuthenticated, getAccessTokenSilently, user, isLoading } = useAuth0();
    const [codebaseId, setCodebaseId] = useState("");
    const [messages, setMessages] = useState([new Message(WELCOME_MESSAGE, true, true)]);
    const [subscriptionStatus, setSubscriptionStatus] = useState({});
    const [renderSubscriptionModal, setRenderSubscriptionModal] = useState(false);
    const [fileContext, setFileContext] = useState("");
    const [displayCodeExplorer, setDisplayCodeExplorer] = useState(true);
    const websocket = useRef(null);
    const prevAuthState = useRef(isAuthenticated);
    const router = useRouter();

    function onBeforeUnload(event) {
        // event.preventDefault();
        websocket.current.close();
    }

    function openWebsocketConnection(callback) {
        if (websocket.current != null) {
            callback(websocket.current);
            return;
        }

        let ws = new WebSocket(`${process.env.NEXT_PUBLIC_WEBSOCKET_URI}answer_query`);
        ws.onopen = event => {
            websocket.current = ws;
            window.addEventListener("beforeunload", onBeforeUnload);

            callback(ws);
        };
        ws.onmessage = event => {
            if (event.data == "ping") {
                ws.send("pong");
                return;
            }

            const {
                type,
                data,
                is_finished,
                is_paywalled,
                progress_target,
                error
            } = JSON.parse(event.data);

            if (type === "loading") {
                const { type: stepType, content } = data;

                setMessages(prevMessages => {
                    const priorMessages = prevMessages.slice(0, prevMessages.length - 1);
                    let lastMessage = prevMessages[prevMessages.length - 1];

                    if (lastMessage.steps.length === 0) { // First loading step
                        lastMessage.steps.push(data);
                    } else {
                        const lastLoadingStep = lastMessage.steps[lastMessage.steps.length - 1];
                        if (lastLoadingStep.type === stepType) { // Same loading step
                            lastLoadingStep.content += content;
                            lastMessage.steps[lastMessage.steps.length - 1] = lastLoadingStep;
                        } else if (stepType.toLowerCase() == "progress") { // Progress update
                            lastMessage.progress += 1;
                            lastMessage.progressTarget = progress_target;
                        } else { // New loading step
                            lastMessage.steps.push(data);
                        }
                    }

                    return [...priorMessages, lastMessage];
                });
            } else if (type == "answer") {
                const { message, sources } = data;

                setMessages(prevMessages => {
                    const priorMessages = prevMessages.slice(0, prevMessages.length - 1);
                    let response = prevMessages[prevMessages.length - 1];

                    response.content += message;
                    response.isComplete = is_finished;
                    response.isPaywalled = is_paywalled;
                    response.sources = sources.map(filePath => new Source(filePath));
                    response.progressTarget = null;
                    response.steps = response.steps.filter(step => step.type.toLowerCase() != "progress");

                    return [...priorMessages, response];
                });
            }
        }
        ws.onerror = event => {
            websocket.current = null;
            window.removeEventListener("beforeunload", onBeforeUnload);
        }
        ws.onclose = event => {
            console.log("Closed??")
            websocket.current = null;
            window.removeEventListener("beforeunload", onBeforeUnload);
        }
    }

    function handleOAuthCallback() {
        const { source, code } = router.query;

        if (!source) {
            return;
        }

        getAccessTokenSilently()
            .then(token => {
                fetch(`${process.env.NEXT_PUBLIC_API_URI}api/${source}_callback`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${token}`
                    },
                    body: JSON.stringify({ user_id: user.sub, code })
                })
                    .then(res => res.json())
                    .then(data => {
                        // TODO: Update state to tell CodeExplorer to render the SelectRepository view
                    })
            });
    }

    function fetchUserMetadata() {
        if (!isAuthenticated) {
            return;
        }

        if (Object.keys(subscriptionStatus).length != 0) {
            return;
        }

        getAccessTokenSilently()
            .then(token => {
                fetch(`${process.env.NEXT_PUBLIC_API_URI}api/stripe/subscription_status`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        user_id: user.sub,
                        email: user.email
                    })
                })
                    .then(res => res.json())
                    .then(data => {
                        const {
                            plan,
                            num_messages_sent,
                            num_repositories_indexed,
                            num_code_snippets_indexed
                        } = data;

                        setSubscriptionStatus({
                            plan,
                            numMessagesSent: num_messages_sent,
                            numRepositoriesIndexed: num_repositories_indexed,
                            numCodeSnippetsIndexed: num_code_snippets_indexed
                        });
                    });
            });
    }

    function setShowSubscriptionModal(isVisible) {
        setRenderSubscriptionModal(isVisible);
    }

    function getChatHistory() {
        return messages
            .slice(1)
            .map(message => {
                return {
                    content: message.content,
                    is_response: message.isResponse
                };
            })
            .filter((message, index) => index < messages.length - 3);
    }

    function onSubmitQuery(message, regenerate = false) {
        const query = new Message(message, false, true);
        let response = new Message("", true, false);

        if (!isAuthenticated) { // TODO: Display blurred output and prompt user to sign up
            response.content = "You must be signed in to use the chatbot.";
            response.isComplete = true;
        }

        setMessages(prevMessages => {
            if (regenerate) {
                let priorMessages = prevMessages.slice(0, prevMessages.length - 1);
                return [...priorMessages, response];
            }

            let priorMessages = prevMessages.slice(0, prevMessages.length);
            return [...priorMessages, query, response];
        });

        if (!isAuthenticated) {
            return;
        }

        getAccessTokenSilently()
            .then(token => {
                openWebsocketConnection(ws => {
                    const request = {
                        user_id: user.sub,
                        token: token,
                        codebase_id: codebaseId,
                        query: message,
                        chat_history: getChatHistory()
                    };
                    ws.send(JSON.stringify(request));

                    console.log("sent stuff")

                    Mixpanel.track("received_chatbot_response", { query: message });
                })
            });
    }

    function onSetCodebaseId(codebaseId) {
        setCodebaseId(codebaseId);

        let priorMessages = JSON.parse(localStorage.getItem(codebaseId))
        if (priorMessages) {
            priorMessages = priorMessages.filter(message => message.isComplete);
            setMessages(priorMessages);
        } else {
            const newMessages = [new Message(WELCOME_MESSAGE, true, true)];
            setMessages(newMessages);
            localStorage.setItem(codebaseId, JSON.stringify(newMessages));
        }
    }

    function onClearConversation() {
        setMessages([new Message(WELCOME_MESSAGE, true, true)]);
    }

    function onToggleBrowseCode() {
        setDisplayCodeExplorer(!displayCodeExplorer);
    }

    /* Helpers */

    function renderApp() {
        return (
            <div className="app">
                <Header
                    setShowSubscriptionModal={setShowSubscriptionModal}
                    subscriptionPlan={subscriptionStatus.plan}
                />

                {
                    isLoading || (isAuthenticated && Object.keys(subscriptionStatus).length == 0) ?
                        <div id="loadingBody">
                            <Spinner />
                        </div>
                        :
                        <div className="body">
                            <motion.div
                                id="chatBot"
                                initial="closed"
                                animate={displayCodeExplorer ? "closed" : "open"}
                                variants={{
                                    open: { width: "100%", maxWidth: "100%" },
                                    closed: { width: "40%", maxWidth: "40%" }
                                }}
                                transition={{ duration: 0.25, ease: "easeInOut" }}
                            >
                                <ChatBot
                                    messages={messages}
                                    onSubmitQuery={onSubmitQuery}
                                    onUpgradePlan={() => setShowSubscriptionModal(true)}
                                    setFileContext={setFileContext}
                                    onClearConversation={onClearConversation}
                                    codebaseId={codebaseId}
                                    onToggleBrowseCode={onToggleBrowseCode}
                                    isBrowseCodeToggled={displayCodeExplorer}
                                />
                            </motion.div>
                            <CodeExplorer
                                onSetCodebaseId={onSetCodebaseId}
                                codebaseId={codebaseId}
                                onUpgradePlan={() => setShowSubscriptionModal(true)}
                                setFileContext={setFileContext}
                                fileContext={fileContext}
                                isVisible={displayCodeExplorer}
                            />
                        </div>
                }
            </div>
        )
    }

    /* Lifecycle Methods */

    useEffect(() => {
        Mixpanel.track("load_playground");
        fetchUserMetadata();
    }, [])

    useEffect(() => {
        if (isAuthenticated) {
            handleOAuthCallback();
        }
    }, [router.isReady])

    useEffect(() => {
        if (prevAuthState.current !== isAuthenticated && isAuthenticated) {
            Mixpanel.identify(user.sub);
            Mixpanel.people.set({ email: user.email });

            handleOAuthCallback();
            fetchUserMetadata();
        }

        prevAuthState.current = isAuthenticated;
    }, [isAuthenticated])

    useEffect(() => {
        if (messages[messages.length - 1].isComplete) {
            localStorage.setItem(codebaseId, JSON.stringify(messages));
        }
    }, [messages]);

    return (
        <>
            {renderApp()}
            {renderSubscriptionModal ?
                <div className={"grid p-2 justify-items-center"}>
                    <SubscriptionModal setShowSubscriptionModal={setShowSubscriptionModal} />
                </div>
                : null
            }
        </>
    );

}