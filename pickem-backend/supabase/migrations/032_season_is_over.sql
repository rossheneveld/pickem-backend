import React from "react";
import { View, Text, ScrollView, TouchableOpacity } from "react-native";
import { styles } from "../theme/styles";

const INSTRUCTION_STEPS = [
  {
    icon: "🏈",
    title: "1. Join or start a league",
    body: "Pick NFL or NCAA, and Public (anyone can join) or Private (password required). Leagues run for a full season.",
    example: null,
  },
  {
    icon: "💰",
    title: "2. Everyone starts with points",
    body: "Week 1 begins with 10 points for every game that week — no picking required for this part.",
    example: "Example: NFL has 16 games in Week 1, so you start with 16 × 10 = 160 points.",
  },
  {
    icon: "✅",
    title: "3. Pick a winner for every game",
    body: "Tap the team you think wins each matchup. That's the whole decision — straight-up winner, not against the spread.",
    example: null,
  },
  {
    icon: "🔒",
    title: "4. Picks lock 5 minutes before kickoff",
    body: "Once locked, you can't change that pick or its wager — and other players' picks for that game become visible to you too.",
    example: "Example: if you never pick a winner for the 1:00pm game, at 12:55pm it auto-locks with the minimum wager placed on it, and that wager is automatically lost.",
  },
  {
    icon: "🔥",
    title: "5. Call an upset, earn bonus shares",
    body: "Every game has a favorite and an underdog, based on the real spread. Correctly picking the UNDERDOG earns shares of that week's bonus pot. Shares = the points you wagered × the spread.",
    example: "Example: the Jets are a +5 underdog. You wager 12 points on them. They win. You earn 12 × 5 = 60 shares of the bonus pot.",
  },
  {
    icon: "💸",
    title: "6. The bonus pot",
    body: "Every wrong pick's wagered points go into the pot instead of back to that player. At the end of the week, the pot is split among everyone who earned shares, proportional to how many shares they earned.",
    example: "Example: the pot is 500 points. You earned 60 of the week's 200 total shares — that's 30%, so you receive 150 points on top of the points you kept from correct picks.",
  },
  {
    icon: "🤝",
    title: "7. A tie pushes",
    body: "If a game ends tied, whatever you wagered on it comes straight back — no gain, no loss, and no shares either way.",
    example: null,
  },
  {
    icon: "🔁",
    title: "8. Wager everything, every week",
    body: "Starting Week 2, your entire balance from last week must be spread across this week's games — minimum 5 points per game (drops to 1 if your balance is thin). Anything left unassigned when the week locks is forfeited to the pot.",
    example: "Example: you enter Week 2 with 145 points across 16 games. You could split it evenly (~9 each) or weight it toward games you feel strongly about — as long as it all adds up to 145 and nothing is left over.",
  },
  {
    icon: "🎓",
    title: "9. NCAA: choosing the week's 15 games",
    body: "The league creator picks 15 matchups from a pool of Power Four + Notre Dame games — either hand-picked or randomized. Miss the deadline and 15 are auto-randomized for the whole league.",
    example: null,
  },
  {
    icon: "📊",
    title: "10. Track everything",
    body: "Tap any player in Standings to see their picks. The Leaderboards tab breaks down weekly standings, who's had the most correct picks overall, and who's called the most underdogs right — all within your league. The Picks tab shows what everyone chose, for this week or any past week. And on the Home screen, two scoreboards rank you across every league on Odd Dog: Top Dog for underdog-calling accuracy, and Sharpest Picks for overall pick accuracy.",
    example: null,
  },
  {
    icon: "🏆",
    title: "11. The season's final game",
    body: "Both NFL and NCAA narrow down through real playoffs, with fewer games each week — down to one: the Super Bowl for NFL, the National Championship for NCAA. Just like every other week, that final game is auto-assigned for everyone to pick; there's no creator choice once the field gets that small.",
    example: null,
  },
  {
    icon: "👑",
    title: "12. Crowning the season's winners",
    body: "Once the final game is scored, whoever has the most points in your league is the season champion. Beyond your own league, the Home screen's Top Dog and Sharpest Picks scoreboards rank underdog-calling and overall pick accuracy across every league on Odd Dog.",
    example: null,
  },
  {
    icon: "🎯",
    title: "13. Covers leagues (NFL Covers and NCAA Covers)",
    body: "Covers leagues add a second way to pick each game. Win outright works exactly like a standard league. Cover the spread lets you back a team to beat the point spread instead: the favorite by more than the spread, or the underdog by winning or losing by less than it. A correct cover returns your wager and earns bonus-pot shares equal to the points you wagered. A margin exactly on the spread is a push and your points come back. A wrong pick loses its wager to the bonus pot, as always.",
    example: "Example: you wager 35 points on the favorite to cover and they cover. You get your 35 points back plus 35 shares of the bonus pot.",
  },
];


export default function InstructionsScreen({ onBack }) {
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={[styles.homeButton, { marginBottom: 6 }]}>
          <Text style={styles.homeButtonText}>‹ Home</Text>
        </TouchableOpacity>
        <Text style={styles.headerLabel}>How to Play</Text>
        <Text style={styles.headerBalance}>Odd Dog</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60, gap: 12 }}>
        {INSTRUCTION_STEPS.map((step) => (
          <View key={step.title} style={[styles.card, { borderStyle: "solid" }]}>
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
              <Text style={{ fontSize: 26 }}>{step.icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.yourPickText}>{step.title}</Text>
                <Text style={[styles.smallText, { marginTop: 4, lineHeight: 18 }]}>{step.body}</Text>
                {step.example && (
                  <View style={styles.exampleBox}>
                    <Text style={{ color: "#f1bf45", fontSize: 12, lineHeight: 17 }}>{step.example}</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}