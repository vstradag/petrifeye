// MAGNETIC POETRY — the poems.
//
// Complete poems whose next word can usually be guessed — from rhyme,
// repetition or plain sense — until the end turns somewhere you did not expect.
// Every one is public domain in both the EU (author, and translator, dead more
// than 70 years) and the US (published before 1931). Each text was checked
// word for word against the edition named in `source` (Project Gutenberg and
// Internet Archive copies of those editions), keeping its spelling and
// punctuation — "mid night" and "memorial mould" are the originals.
//
// Two sets, each from easiest to hardest:
//   POEMS         the piece: 8-22 words, mostly two to four short lines
//   POEMS_LONGER  for players who have the hang of it (settings → poems)
//
// Leading spaces indent a line, as printed. An untitled poem goes by its
// first line. To add one: a complete, public-domain text, checked against an
// edition, with a turn at the end.
window.POEMS = [
  {
    // Hearn gives Bashō's hokku as a gloss in one line, “Old pond--frogs
    // jumping in--sound of water.”; broken here at his dashes into the
    // three lines of the original.
    title: "Furu iké ya",
    author: "Matsuo Bashō", dates: "1644–1694",
    translator: "Lafcadio Hearn",
    source: "Exotics and Retrospectives, 1898",
    text: "Old pond—\nfrogs jumping in—\nsound of water.",
  },
  {
    title: "Moon Haze",
    author: "Amy Lowell", dates: "1874–1925",
    source: "Pictures of the Floating World, 1919",
    text: "Because the moonlight deceives\nTherefore I love it.",
  },
  {
    title: "Nuance",
    author: "Amy Lowell", dates: "1874–1925",
    source: "Pictures of the Floating World, 1919",
    text: "Even the iris bends\nWhen a butterfly lights upon it.",
  },
  {
    title: "Motherless baby and babyless mother",
    author: "Christina Rossetti", dates: "1830–1894",
    source: "Sing-Song, 1872 (text of the 1893 edition)",
    text: "Motherless baby and babyless mother,\nBring them together to love one another.",
  },
  {
    title: "The Sun-Dial",
    author: "Adelaide Crapsey", dates: "1878–1914",
    source: "Verse, 1915",
    text: "Every day,\nEvery day,\nTell the hours\nBy their shadows,\nBy their shadows.",
  },
  {
    title: "Poetry",
    author: "Amy Lowell", dates: "1874–1925",
    source: "Pictures of the Floating World, 1919",
    text: "Over the shop where silk is sold\nStill the dragon kites are flying.",
  },
  {
    title: "Nuit Blanche",
    author: "Amy Lowell", dates: "1874–1925",
    source: "Pictures of the Floating World, 1919",
    text: "The chirping of crickets in the night\nIs intermittent,\nLike the twinkling of stars.",
  },
  {
    title: "Niagara",
    subtitle: "Seen on a Night in November",
    author: "Adelaide Crapsey", dates: "1878–1914",
    source: "Verse, 1915",
    text: "How frail\nAbove the bulk\nOf crashing water hangs,\nAutumnal, evanescent, wan,\nThe moon.",
  },
  {
    title: "Autumn Haze",
    author: "Amy Lowell", dates: "1874–1925",
    source: "Pictures of the Floating World, 1919",
    text: "Is it a dragonfly or a maple leaf\nThat settles softly down upon the water?",
  },
  {
    title: "Faith is a fine invention",
    author: "Emily Dickinson", dates: "1830–1886",
    source: "Poems, Second Series, 1891",
    text: "Faith is a fine invention\nFor gentlemen who see;\nBut microscopes are prudent\nIn an emergency!",
  },
  {
    title: "Wrens and robins in the hedge",
    author: "Christina Rossetti", dates: "1830–1894",
    source: "Sing-Song, 1872 (text of the 1893 edition)",
    text: "Wrens and robins in the hedge,\nWrens and robins here and there;\nBuilding, perching, pecking, fluttering,\nEverywhere!",
  },
  {
    title: "Peace",
    author: "Amy Lowell", dates: "1874–1925",
    source: "Pictures of the Floating World, 1919",
    text: "Perched upon the muzzle of a cannon\nA yellow butterfly is slowly opening and shutting its wings.",
  },
  {
    title: "Happy Thought",
    author: "Robert Louis Stevenson", dates: "1850–1894",
    source: "A Child’s Garden of Verses, 1885",
    text: "The world is so full of a number of things,\nI’m sure we should all be as happy as kings.",
  },
  {
    title: "Mix a pancake",
    author: "Christina Rossetti", dates: "1830–1894",
    source: "Sing-Song, 1872 (text of the 1893 edition)",
    text: "Mix a pancake,\nStir a pancake,\nPop it in the pan;\nFry the pancake,\nToss the pancake,—\nCatch it if you can.",
  },
];

window.POEMS_LONGER = [
  {
    title: "Susanna and the Elders",
    author: "Adelaide Crapsey", dates: "1878–1914",
    source: "Verse, 1915",
    text: "“Why do\nYou thus devise\nEvil against her?”  “For that\nShe is beautiful, delicate;\nTherefore.”",
  },
  {
    title: "The pedigree of honey",
    author: "Emily Dickinson", dates: "1830–1886",
    source: "Poems, 1890",
    text: "The pedigree of honey\nDoes not concern the bee;\nA clover, any time, to him\nIs aristocracy.",
  },
  {
    title: "A Word",
    author: "Emily Dickinson", dates: "1830–1886",
    source: "Poems, Third Series, 1896",
    text: "A word is dead\nWhen it is said,\n  Some say.\nI say it just\nBegins to live\n  That day.",
  },
  {
    title: "Triad",
    author: "Adelaide Crapsey", dates: "1878–1914",
    source: "Verse, 1915",
    text: "These be\nThree silent things:\nThe falling snow . . . the hour\nBefore the dawn . . . the mouth of one\nJust dead.",
  },
  {
    title: "Amaze",
    author: "Adelaide Crapsey", dates: "1878–1914",
    source: "Verse, 1915",
    text: "I know\nNot these my hands\nAnd yet I think there was\nA woman like me once had hands\nLike these.",
  },
  {
    title: "A man said to the universe",
    author: "Stephen Crane", dates: "1871–1900",
    source: "War Is Kind, 1899",
    // The 1899 printing opens the last line with a continuation quote mark
    // (“A sense…), a convention of its day; dropped so it does not read as
    // a misprint.
    text: "A man said to the universe:\n“Sir, I exist!”\n“However,” replied the universe,\n“The fact has not created in me\nA sense of obligation.”",
  },
  {
    title: "Water is taught by thirst",
    author: "Emily Dickinson", dates: "1830–1886",
    source: "Poems, Third Series, 1896",
    text: "Water is taught by thirst;\nLand, by the oceans passed;\n  Transport, by throe;\nPeace, by its battles told;\nLove, by memorial mould;\n  Birds, by the snow.",
  },
  {
    title: "To make a prairie",
    author: "Emily Dickinson", dates: "1830–1886",
    source: "Poems, Third Series, 1896",
    text: "To make a prairie it takes a clover and one bee,—\nOne clover, and a bee,\nAnd revery.\nThe revery alone will do\nIf bees are few.",
  },
  {
    title: "Above the Dock",
    author: "T. E. Hulme", dates: "1883–1917",
    source: "The Complete Poetical Works of T. E. Hulme, in Ezra Pound’s Ripostes, 1912",
    text: "Above the quiet dock in mid night,\nTangled in the tall mast’s corded height,\nHangs the moon. What seemed so far away\nIs but a child’s balloon, forgotten after play.",
  },
];
