//shuffle array
function shuffle(array) {
    array.sort(() => Math.random() - 0.5);
}

shuffle(questions);

//add team
let currentTeamIndex = 0;
const teams = JSON.parse(sessionStorage.getItem('teams'));
console.log(teams);
document.querySelector("#current_team").innerText = "Team: " + teams[currentTeamIndex]

function updateTeam() {
    currentTeamIndex = (currentTeamIndex + 1) % teams.length;
    document.querySelector("#current_team").innerText = "Team: " + teams[currentTeamIndex];
    console.log("Team: " + teams[currentTeamIndex]);
}

//keep track of points
let points = [];
points.length = teams.length;
for (let i = 0; i < points.length; i++) {
    points[i] = 0;
}

//choose question
let currentQuestionIndex = 0;

//add question

function updateQuestion() {
    document.querySelector("body > div.question-wrapper > h1").innerText = questions[currentQuestionIndex]["question"];

    //shuffle options
    shuffle(questions[currentQuestionIndex]["options"])

    //add options
    document.querySelector("#option1").innerText = questions[currentQuestionIndex]["options"][0];
    document.querySelector("#option2").innerText = questions[currentQuestionIndex]["options"][1];
    document.querySelector("#option3").innerText = questions[currentQuestionIndex]["options"][2];
    document.querySelector("#option4").innerText = questions[currentQuestionIndex]["options"][3];
}

updateQuestion();

//check if correct
function checkAnswer(optionID) {
    console.log(optionID)
    if (optionID.innerHTML === questions[currentQuestionIndex]["correct"]) {
        //Add points
        points[currentTeamIndex]++;

        //Move to next team

        console.log(points);

        //correct modal
        document.querySelector(".check_modals#correct").classList.add("show");



    } else {
        document.querySelector(".check_modals#incorrect").classList.add("show");

    }

    //Move to next question
    nextQuestion()
    updateTeam();


}

//hide modals when complete

function hideCheckModals() {
    document.querySelectorAll(".check_modals").forEach((modal) => {
        modal.classList.remove("show");
    })
}







function nextQuestion() {
    currentQuestionIndex++;
    if (currentQuestionIndex >= questions.length) {
        endGame();
    }
    updateQuestion();
}

function endGame() {
    sessionStorage.setItem('points', JSON.stringify(points));
    window.location.href="./end.html"
}

function restart(){
    for (let i = 0; i < points.length; i++) {
        points[i] = 0;
    }

    shuffle(questions);
}

function viewScores(){
    document.querySelector(".check_modals#score").classList.add("show");
    document.querySelector(".scores-chart").innerHTML="";
    for(let i = 0; i < teams.length; i++){
        document.querySelector(".scores-chart").innerHTML+="<p>"+teams[i]+": <b>"+points[i]+" point(s)</b> </p>"
    }
}

function exitGame(){
    window.location.href="/gauravs version/index.html"
}