// Initialize teams and points in session storage if not already initialized
if (!sessionStorage.getItem('teams')) {
    const initialTeams = ['Team A', 'Team B']; // Modify as per your team names
    sessionStorage.setItem('teams', JSON.stringify(initialTeams));
}

const initialPoints = {};
JSON.parse(sessionStorage.getItem('teams')).forEach(team => {
    initialPoints[team] = 0;
});
sessionStorage.setItem('points', JSON.stringify(initialPoints));


let attempts = 0;
let currentQuestionIndex = 0;
const teams = JSON.parse(sessionStorage.getItem('teams'));
let points = JSON.parse(sessionStorage.getItem('points'));
let currentTeamIndex = 0;
document.querySelector("#current_team").innerText = "Team: " + teams[currentTeamIndex];


function shuffleQuestions(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function loadQuestion(index) {
    const questionWrapper = document.querySelector('.question-wrapper');
    const questionElement = questionWrapper.querySelector('.question');
    const optionButtons = questionWrapper.querySelectorAll('.option-button');

    const currentQuestion = questions[index];
    questionElement.textContent = currentQuestion.question;
    optionButtons.forEach((button, idx) => {
        button.textContent = currentQuestion.options[idx];
        button.dataset.correct = currentQuestion.options[idx] === currentQuestion.correct;
    });
}

function handleOptionClick(event) {
    attempts++;
    const isCorrect = event.target.dataset.correct === 'true';
    const currentTeam = teams[currentTeamIndex];
    let nextTeam = teams[(currentTeamIndex + 1) % teams.length];

    if (isCorrect) {
        document.querySelector(".how-to-play-overlay#correct").classList.toggle("dont-show");
        document.querySelector(".how-to-play#correct-modal").classList.toggle("dont-show");
        points[currentTeam]++;
    } else {
        alert(`${currentTeam} is Incorrect! ${nextTeam} can try to steal.`);
        if (event.target.dataset.steal) {
            alert(`${nextTeam} steals and is Correct!`);
            points[nextTeam] += 0.5;
        } else {
            alert(`${nextTeam} is incorrect. No points earned.`);
        }
    }

    sessionStorage.setItem('points', JSON.stringify(points));
    currentTeamIndex = (currentTeamIndex + 1) % teams.length;
    document.querySelector("#current_team").innerText = "Team: " + teams[currentTeamIndex];
    loadQuestion(currentQuestionIndex);
    return isCorrect;
}

shuffleQuestions(questions);
loadQuestion(currentQuestionIndex);

const optionButtons = document.querySelectorAll('.option-button');
optionButtons.forEach(button => {
    button.addEventListener('click', handleOptionClick);
});

function nextQuestioninGame() {
    currentQuestionIndex++;
    if (currentQuestionIndex >= questions.length) {
        endGame();
    }
}

function endGame() {
    window.location.href = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}