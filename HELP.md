# Bot business logic:

01. Get all maven repositories the developers cloned into the folder in configuration;
02. Check for new commits the developers made in the meantime the bot was not online;
03. Check for a [RELEASE] keyword in the commit's message;
04. If nothing found, quit;
05. If something found, foreach [RELEASE], continue;
06. does mvn release:clean, mvn release:prepare, mvn release:perform;
07. mvn commands at 06 will automatically create at least 2 commits and a tag, so it will do commit & push;
08. Saves new version of the POM modified by mvn release:prepare;
09. For every other pom repo, does mvn compile two times to assure every repo has the new repo version;
10. For those repo that, after 09 has a different pom from the one fetched in 01, goto 06.

# Testing scenarios

## First Scenario

0. Commit & Push an update commit with [RELEASE] tag in commit message
**NOTE: If you forgot add in commit message [RELEASE] tag the script will not retrive changes and run the other tasks**
1. Go to a previous non [RELEASE] commit;
2. Run the script;
3. The bot takes the latest version it has (the non [RELEASE] at point 1)
3. The bot pulls all the repos;
4. The bot now received the lastest [RELEASE] commit;
5. The bot triggers its behavior