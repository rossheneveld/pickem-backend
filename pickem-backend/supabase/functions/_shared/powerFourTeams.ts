// supabase/functions/_shared/powerFourTeams.ts
//
// The Odds API's NCAAF team names are "School Mascot" (e.g. "California
// Golden Bears", "UNLV Rebels") — confirmed directly from their own API
// documentation, not guessed. This list uses that exact format.
//
// Power 4 conference membership (ACC, Big Ten, Big 12, SEC) is stable for
// the 2026 season — no changes from the prior year, per current reporting
// as of this file being written. Membership does shift over time in
// college sports, though, so if a game is ever missing that should be
// included (or vice versa), this is the one place to update — a single
// shared list, not duplicated across multiple functions.
//
// If any team here turns out to be wrong (a mascot name slightly off, or a
// team missing), it'll show up as that team's games silently not appearing
// in any league's pool — worth spot-checking against real synced data
// rather than assuming this list is perfect on the first pass.

export const POWER_FOUR_TEAMS = new Set([
  // ACC (17)
  "Boston College Eagles", "California Golden Bears", "Clemson Tigers", "Duke Blue Devils",
  "Florida State Seminoles", "Georgia Tech Yellow Jackets", "Louisville Cardinals", "Miami Hurricanes",
  "NC State Wolfpack", "North Carolina Tar Heels", "Pittsburgh Panthers", "SMU Mustangs",
  "Stanford Cardinal", "Syracuse Orange", "Virginia Cavaliers", "Virginia Tech Hokies", "Wake Forest Demon Deacons",

  // Big Ten (18)
  "Illinois Fighting Illini", "Indiana Hoosiers", "Iowa Hawkeyes", "Maryland Terrapins",
  "Michigan Wolverines", "Michigan State Spartans", "Minnesota Golden Gophers", "Nebraska Cornhuskers",
  "Northwestern Wildcats", "Ohio State Buckeyes", "Oregon Ducks", "Penn State Nittany Lions",
  "Purdue Boilermakers", "Rutgers Scarlet Knights", "UCLA Bruins", "USC Trojans", "Washington Huskies", "Wisconsin Badgers",

  // Big 12 (16)
  "Arizona Wildcats", "Arizona State Sun Devils", "Baylor Bears", "BYU Cougars",
  "Cincinnati Bearcats", "Colorado Buffaloes", "Houston Cougars", "Iowa State Cyclones",
  "Kansas Jayhawks", "Kansas State Wildcats", "Oklahoma State Cowboys", "TCU Horned Frogs",
  "Texas Tech Red Raiders", "UCF Knights", "Utah Utes", "West Virginia Mountaineers",

  // SEC (16)
  "Alabama Crimson Tide", "Arkansas Razorbacks", "Auburn Tigers", "Florida Gators",
  "Georgia Bulldogs", "Kentucky Wildcats", "LSU Tigers", "Mississippi State Bulldogs",
  "Missouri Tigers", "Ole Miss Rebels", "Oklahoma Sooners", "South Carolina Gamecocks",
  "Tennessee Volunteers", "Texas Longhorns", "Texas A&M Aggies", "Vanderbilt Commodores",

  // Independent
  "Notre Dame Fighting Irish",
]);

/** A game counts if EITHER team is Power 4 / Notre Dame — this correctly
 * keeps a game like "Ohio State vs. a Group of Five opponent," not just
 * games where both teams qualify. */
export function isPowerFourGame(homeTeam: string, awayTeam: string): boolean {
  return POWER_FOUR_TEAMS.has(homeTeam) || POWER_FOUR_TEAMS.has(awayTeam);
}