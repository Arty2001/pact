"""
The voiceover, one entry per beat.

This is a scratch track. It exists so the cut can be judged on whether the
ideas land in the time they are given, and it is meant to be replaced by a
real read. Keep the text here in step with the script document; the words are
the contract, the voice is not.

Spellings are tuned for the synthesiser rather than for the page: "three point
five" instead of "3.5", "seven fourteen" instead of "7:14". A model name read
as a decimal number is the fastest way to make a technical video sound wrong.
"""

VOICE = "en-US-AndrewNeural"

#: Slightly under the default. The default reads at about 170 words a minute,
#: which is faster than any of these beats are written for, and the dense ones
#: stop being followable.
RATE = "-6%"

LINES: list[tuple[str, str]] = [
    (
        "b1",
        "Everyone has goals. "
        "The hard part was never deciding. It's keeping track. "
        "So for the Nebius and NVIDIA hackathon, we built a personal assistant "
        "that watches, and keeps you on top of them. "
        "But sending frames of your day into a frontier model "
        "runs hundreds of dollars a day, per camera. "
        "So Pact is designed to do it for almost nothing.",
    ),
    (
        "demo",
        "Here's the whole thing, running. "
        "You give it a goal. It works out what to watch for, and starts watching. "
        "Every camera you've got. "
        "Then you go and do it. "
        "It fills itself in. "
        "Here's how.",
    ),
    (
        "b2",
        "You start with a goal. Type it, or say it out loud. "
        "I want to do twenty pushups every morning.",
    ),
    (
        "b3",
        "Nemotron breaks it into sub-goals. "
        "Someone in a room. Someone in a pushup position. Twenty of them, before noon. "
        "But a camera gives you pixels, and a sub-goal is words. "
        "Those don't compare. Unless you put them in the same space. "
        "That's the NVIDIA encoder. It turns the frame into a list of numbers, "
        "and turns the sentence into a list of numbers of exactly the same kind. "
        "Two points on one map. "
        "And asking whether this is a pushup is just asking how close they are.",
    ),
    (
        "b4",
        "Every sub-goal becomes a simple comparison between embeddings. "
        "Watching for fifty things costs barely more than watching for one. "
        "We also made sure to be smart about which sub-goals are being watched. "
        "We reuse sub-goals from other goals, "
        "so everything stacks into one clean tree of goals and sub-goals.",
    ),
    (
        "b5",
        "And that tree has a hierarchy. A still room doesn't even send a frame. "
        "When you walk in, one sub-goal passes and wakes the one beneath it. "
        "Everything else stays asleep, never scored. "
        "It only works as hard as it needs to.",
    ),
    (
        "b6",
        "It can also count. One up and down, one entry. "
        "It won't count a flicker, and it won't count twice. "
        "And when something doesn't count, it says why. "
        "Too short, or never confident enough.",
    ),
    (
        "b7",
        "When it can't tell on its own, it doesn't guess. "
        "Four frames go to Nemotron three point five Super V L. "
        "When even that's unsure, or no camera could read it, like the weight on a bar, "
        "it asks you. "
        "Your answer becomes a new label. "
        "The models never change, but the detector on top sharpens.",
    ),
    (
        "b8",
        "Now this one system can track any type of goal. "
        "Keep the sink clear. Now the sub-goal firing is the failure. "
        "And you can add as many video streams as you want. "
        "A phone. A screen share. A thirty dollar board. "
        "We pointed it at our phone recording a whole gym workout, "
        "and it logged the entire session, "
        "without me putting anything in manually.",
    ),
    (
        "b9",
        "Every goal is a few things a camera can see, and a rule about them. "
        "No video is kept. Every goal it settled is still there to explain. "
        "You already made the promise. Pact is the part that keeps it.",
    ),
]
