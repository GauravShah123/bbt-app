//calculate winner

const teams = JSON.parse(sessionStorage.getItem('teams'));
let points = JSON.parse(sessionStorage.getItem('points'));

// Find the maximum points
const maxPoints = Math.max(...points);

// Find all teams that have the maximum points
const winningTeams = teams.filter((team, index) => points[index] === maxPoints);

// Determine the result
let result;
if (winningTeams.length === 1) {
  result = `The winning team is ${winningTeams[0]}.`;
} else {
  result = `There is a tie between the following teams: ${winningTeams.join(', ')}.`;
}

document.querySelector("h1").innerText = result;

//display final scores
document.querySelector(".scores-chart").innerHTML = "";
for (let i = 0; i < teams.length; i++) {
    document.querySelector(".scores-chart").innerHTML += "<p>" + teams[i] + ": <b>" + points[i] + " point(s)</b> </p>"
}