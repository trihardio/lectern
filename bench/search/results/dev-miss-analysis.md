# Miss analysis: dev-keywords-base

Run dev-keywords-base: split dev, 56 questions, queries keywords. 1153 gold papers are outside the top 25 of 1182. Looked up in OpenAlex with batched filter-only requests (live requests this process: 0, cache hits 24). No filter was applied in the run, so no paper is out of range of a filter.

Reasons, tested in order: see the header of `bench/search/miss.js`. "Query words missing" is approximate: a word counts as present when its crude stem (trailing -ing, -ed, -es, -s removed) is among the stems of the title and abstract.

| Group | Gold outside top 25 | ranked below the cut | not in OpenAlex | no abstract | query words missing | words all present |
|---|---|---|---|---|---|---|
| all | 1153 | 12 (1%) | 10 (1%) | 377 (33%) | 744 (65%) | 10 (1%) |
| cs | 77 | 2 (3%) | 8 (10%) | 24 (31%) | 43 (56%) | 0 (0%) |
| environment-other | 139 | 0 (0%) | 0 (0%) | 52 (37%) | 85 (61%) | 2 (1%) |
| health | 554 | 7 (1%) | 1 (0%) | 163 (29%) | 377 (68%) | 6 (1%) |
| social-business-education | 383 | 3 (1%) | 1 (0%) | 138 (36%) | 239 (62%) | 2 (1%) |

## Query words missing from title and abstract (744 papers)

accurate (94), good (57), say (54), people (51), adults (51), higher (46), work (45), makes (45), new (40), technologies (40), learning (39), nature (38), community (38), check (37), support (36)

Missing words per such paper: mean 3.7; 51 papers lack exactly one word.

## Examples

- query words missing (missing: e, work, students): "eLearning Platform for Personalized Therapy of Learning Disabilities" for the question "How well does online e-learning work for students with cognitive disabilities?"; query: well online e-learning work students cognitive disabilities
- query words missing (missing: improve, achievement, k, 12): "An Experimental Test of Constructivist Educational Environments." for the question "Does service learning improve academic achievement for K-12 students?"; query: service learning improve academic achievement k-12 students
- query words missing (missing: say, makes, good, learning, environment, higher, education): "International Students and the First Year of College" for the question "What do international students say makes a good learning environment in higher education?"; query: international students say makes good learning environment higher education
- query words missing (missing: say, affects): "Verbal redundancy in multimedia learning environments: A meta-analysis." for the question "What does research say about how multimedia design affects learning?"; query: research say multimedia design affects learning
- query words missing (missing: fewer, women, men, higher, stem, courses): "How do engineering attitudes vary by gender and motivation? Attractiveness of outreach sci" for the question "Why are there fewer women than men in higher education STEM courses?"; query: fewer women men higher education stem courses
- not in OpenAlex: "Element-aware Summarization with Large Language Models: Expert-aligned Evaluation and Chai" for the question "(LitSearch question lit-444; text not published, the dataset states no licence)"; query: paper first applied chain-of-thought technique text summarization field
