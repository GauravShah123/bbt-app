let teamCount = 2;

function addTeam() {
    const teamsContainer = document.getElementById('teams_container');
    if (teamsContainer.childElementCount < 5) {
        teamCount++;
        const teamsContainer = document.getElementById('teams_container');

        const inputRow = document.createElement('div');
        inputRow.className = 'input_row';

        const input = document.createElement('input');
        input.type = 'text';
        input.name = 'team';
        input.class = 'team_input';
        input.id = 'team' + teamCount;
        input.placeholder = 'Team ' + teamCount + ' Name';

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.innerText = '-';
        removeButton.onclick = function () { removeTeam(this); };

        inputRow.appendChild(input);
        inputRow.appendChild(removeButton);

        teamsContainer.appendChild(inputRow);
    }
    else {
        document.querySelector(".toast.error#error2").classList.toggle("dont-show");
        setTimeout(() => {
            document.querySelector(".toast.error#error2").classList.toggle("dont-show");
        }, 2000);

    }
}

function removeTeam(button) {
    const inputRow = button.parentNode;
    const teamsContainer = document.getElementById('teams_container');
    if (teamsContainer.childElementCount > 2) {
        inputRow.parentNode.removeChild(inputRow);
        updateTeamNames();
    } else {
        document.querySelector(".toast.error#error1").classList.toggle("dont-show");
        setTimeout(() => {
            document.querySelector(".toast.error#error1").classList.toggle("dont-show");
        }, 2000);

    }
}

function updateTeamNames() {
    const inputs = document.querySelectorAll('#teams_container .input_row input');
    teamCount = inputs.length;
    inputs.forEach((input, index) => {
        input.id = 'team' + (index + 1);
        input.placeholder = 'Team ' + (index + 1) + ' Name';
    });
}

function startGame() {
    const inputs = document.querySelectorAll('#teams_container .input_row input');
    const teamNames = [];
    let allFilled = true;
    const nameSet = new Set();

    inputs.forEach(input => {
        const trimmedValue = input.value.trim();
        if (trimmedValue === '') {
            allFilled = false;
        } else if (nameSet.has(trimmedValue)) {
            allFilled = false;
            document.querySelector(".toast.error#error4").classList.toggle("dont-show");
            setTimeout(() => {
                document.querySelector(".toast.error#error4").classList.toggle("dont-show");
            }, 2000);
            return;
        } else {
            teamNames.push(trimmedValue);
            nameSet.add(trimmedValue);
        }
    });

    if (!allFilled) {
        document.querySelector(".toast.error#error3").classList.toggle("dont-show");
        setTimeout(() => {
            document.querySelector(".toast.error#error3").classList.toggle("dont-show");
        }, 2000);
    } else {
        // Proceed with starting the game
        sessionStorage.setItem("teams", JSON.stringify(teamNames));
        window.location.href="3-gameplay.html"
    }
}